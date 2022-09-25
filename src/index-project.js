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
import * as fs from "fs";
import "isomorphic-fetch";

if (!process.env.R2_ACCOUNT_ID || 
        !process.env.R2_ACCESS_KEY_ID || 
        !process.env.R2_SECRET_ACCESS_KEY) {
    throw new Error("missing R2 credentials");
}

const s3 = new S3({
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    accessKeyId: `${process.env.R2_ACCESS_KEY_ID}`,
    secretAccessKey: `${process.env.R2_SECRET_ACCESS_KEY}`,
    signatureVersion: 'v4',
});

const token = process.env.GH_BOT_TOKEN;
if (!token) {
    throw new Error("missing GitHub bot token");
}

if (process.argv.length - 2 != 4) {
    throw new Error("expected 4 arguments - BUCKET_NAME, REPO_NAME, ISSUE_NUMBER, PARAMETER_PATH");
}
const bucket_name = process.argv[2];
const repo_name = process.argv[3];
const issue_number = process.argv[4]; 
const param_path = process.argv[5]; 

try {
    // Fetching the issue data.
    let body = JSON.parse(fs.readFileSync(param_path).toString());
    let project = body.project;
    let version = body.version;
    let promises = [];

    // Pulling out the lock file and creating some version-specific metadata.
    let lockpath = project + "/" + version + "/..LOCK";
    let index_time = Date.now();
    {
        let lck = s3.getObject({ Bucket: bucket_name, Key: lockpath });
        let lockinfo;
        
        try {
            lockinfo = await lck.promise();
        } catch (e) {
            throw new Error("failed to acquire the lock file for this project version");
        }
        let lockmeta = JSON.parse(lockinfo.Body.toString());

        let version_meta = {
            upload_time: (new Date(body.timestamp)).toISOString(),
            index_time: (new Date(index_time)).toISOString()
        };

        if ("expiry" in lockmeta) {
            version_meta.expiry_time = (new Date(index_time + lockmeta.expiry)).toISOString();
            let res = await fetch("https://api.github.com/repos/" + repo_name + "/issues", {
                method: "POST",
                body: JSON.stringify({ 
                    "title": "purge expired", 
                    "body": { 
                        project: project,
                        version: version,
                        expiry_time: version_meta.expiry_time,
                        uploaded_by: lockmeta.user
                    }
                }),
                headers: { 
                    "Content-Type": "application/json",
                    Authorization: "Bearer " + token
                } 
            });
            if (!res.ok) {
                throw new Error("failed to post an expiry job");
            }
            let payload = await res.json();
            version_meta.expiry_job_id = payload.number;
        }

        let res = s3.putObject({
            Bucket: bucket_name,
            Key: project + "/" + version + "/..revision.json",
            Body: JSON.stringify(version_meta),
            ContentType: "application/json"
        });
        promises.push(res.promise());
    }

    // Listing all JSON files so we can pull them down in one big clump for each project.
    {
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
                aggregated.push(res.promise().then(stuff => JSON.parse(stuff.Body.toString())));
            }

            if (info.IsTruncated) {
                params.ContinuationToken = info.NextContinuationToken;
            } else {
                break;
            }
        }

        let resolved = await Promise.all(aggregated);
        let res = s3.putObject({ 
            Bucket: bucket_name, 
            Key: project + "/" + version + "/..aggregated.json", 
            Body: JSON.stringify(resolved), 
            ContentType: "application/json" 
        });
        promises.push(res.promise());
    }

    // Checking if permissions exist for the project; if not, we save them.
    {
        let overwrite = body.overwrite_permissions;
        let permpath = project + "/..permissions.json";

        if (!overwrite) {
            try {
                let res = s3.headObject({ Bucket: bucket_name, Key: permpath });
                await res.promise();
            } catch (e) {
                if (e.statusCode == 404) {
                    overwrite = true;
                } else {
                    throw e;
                }
            }
        }

        if (overwrite) {
            let res = s3.putObject({ 
                Bucket: bucket_name, 
                Key: permpath,
                Body: JSON.stringify(body.permissions), 
                ContentType: "application/json" 
            });
            promises.push(res.promise());
        }
    }

    // Checking if we are, indeed, the latest.
    {
        let latestpath = project + "/..latest.json";
        let relatest = false;

        try {
            let lat = s3.getObject({ Bucket: bucket_name, Key: latestpath });
            let latinfo = await lat.promise();
            if (latinfo.index_time < index_time) {
                relatest = true;
            }
        } catch (e) {
            if (e.statusCode == 404) {
                relatest = true;
            } else {
                throw e;
            }
        }

        if (relatest) {
            let res = s3.putObject({
                Bucket: bucket_name,
                Key: latestpath,
                Body: JSON.stringify({  version: version, index_time: index_time }),
                ContentType: "application/json"
            });
            promises.push(res.promise());
        }
    }

    await Promise.all(promises);

    // Deleting the lock file.
    {
        let res = s3.deleteObject({ 
            Bucket: bucket_name,
            Key: lockpath
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
    console.error(e);
    let res = await fetch("https://api.github.com/repos/" + repo_name + "/issues/" + issue_number + "/comments", { 
        method: "POST",
        body: JSON.stringify({ "body": e.message }),
        headers: { 
            "Content-Type": "application/json",
            Authorization: "Bearer " + token
        } 
    });
}
