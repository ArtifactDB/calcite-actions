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
 *
 * In addition, we expect the following command-line variables:
 *
 * 1. The name of the R2 bucket of interest.
 * 2. The name of the project.
 * 3. (optional) The version of the project.
 */

import S3 from 'aws-sdk/clients/s3.js';

const s3 = new S3({
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    accessKeyId: `${process.env.R2_ACCESS_KEY_ID}`,
    secretAccessKey: `${process.env.R2_SECRET_ACCESS_KEY}`,
    signatureVersion: 'v4',
});

if (process.argv.length < 4) {
    throw new Error("expected 3 positional arguments - BUCKET_NAME, PROJECT_NAME and (optional) PROJECT_VERSION");
}
const bucket_name = process.argv[2];
const project = process.argv[3];
const version = process.argv[4]; // TODO: make this optional

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
