/**
 * Index a gypsum project, given command-line arguments specifying the bucket
 * name, project and version. This mostly involves finalizing the JSON files,
 * given that gypsum doesn't have any search capabilities.
 *
 * We expect the following environment variables to be available:
 *
 * - R2_ACCOUNT_ID, the account id for Cloudflare's R2 storage.
 * - R2_ACCESS_KEY_ID, an authorized API key for Cloudflare R2 operations.
 * - R2_SECRET_ACCESS_KEY, an authorized API secret for Cloudflare R2 operations.
 * - GITHUB_TOKEN, a token with read access to the GitHub CI repository reunning this script.
 *
 * In addition, we expect the following command-line variables:
 *
 * 1. The name of the R2 bucket of interest.
 * 2. The full name (owner/repo) of the GitHub CI repository (i.e., the one containing this script).
 * 3. The issue number.
 */

import S3 from 'aws-sdk/clients/s3.js';

const s3 = new S3({
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    accessKeyId: `${process.env.R2_ACCESS_KEY_ID}`,
    secretAccessKey: `${process.env.R2_SECRET_ACCESS_KEY}`,
    signatureVersion: 'v4',
});
const token = process.env.GITHUB_TOKEN;

if (process.argv.length - 2 != 3) {
    throw new Error("expected 3 positional arguments - BUCKET_NAME, REPO_NAME and ISSUE_NUMBER");
}
const bucket_name = process.argv[2];
const repo_name = process.argv[3];
const issue_number = process.argv[4]; 

try {
    // Fetching the issue data.
    let body;
    let title;
    {
        let res = await fetch("https://api.github.com/repos/" + repo_name + "/issues/" + issue_number, { headers: { Authorization: "Bearer " + token } });
        if (!res.ok) {
            throw new Error("failed to fetch issue parameters");
        }
        let info = await res.json();
        body = JSON.parse(info.body);
        title = info.title;
    }

    if (title == "upload complete") {
        let project = body.project;
        let version = body.version;
        let permissions = body.permissions;

        // Listing all JSON files so we can pull them down in one big clump for each project.
        let params = { Bucket: bucket_name, Prefix: project + "/" + version };

        let aggregated = [];
        while (1) {
            let listing = s3.listObjectsV2(params)
            let info = await listing.promise();

            for (const f of info.Contents) {
                if (!f.Key.endsWith(".json")) {
                    continue;
                }

                let res = s3.getObject({ Bucket: bucket_name, Key: f.Key });
                let stuff = await res.promise();
                aggregated.push(JSON.parse(stuff.Body.toString()));
            }

            if (info.IsTruncated) {
                params.ContinuationToken = info.NextContinuationToken;
            } else {
                break;
            }
        }

        // Saving the file.
        let res = s3.putObject({ 
            Bucket: bucket_name, 
            Key: project + "/" + version + "/..aggregated.json", 
            Body: JSON.stringify(aggregated), 
            ContentType: "application/json" 
        });
        await res.promise();
    }

    // Closing the issue once we're successfully done.
    await fetch("https://api.github.com/repos/" + repo_name + "/issues/" + issue_number, { 
        method: "PATCH",
        body: JSON.stringify({ "state": "closed" }),
        headers: { 
            "Content-Type": "application/json",
            Authorization: "Bearer " + token
        } 
    });

} catch (e) {
    // Commenting on the issue.
    let res = await fetch("https://api.github.com/repos/" + repo_name + "/issues/" + issue_number + "/comments", { 
        method: "POST",
        body: JSON.stringify({ "body": e.message }),
        headers: { 
            "Content-Type": "application/json",
            Authorization: "Bearer " + token
        } 
    });
}
