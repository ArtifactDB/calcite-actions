/**
 * Purge projects that have expired or are incomplete (and have expired).
 *
 * We expect the following environment variables to be available:
 *
 * - R2_ACCOUNT_ID, the account id for Cloudflare's R2 storage.
 * - R2_ACCESS_KEY_ID, an authorized API key for Cloudflare R2 operations.
 * - R2_SECRET_ACCESS_KEY, an authorized API secret for Cloudflare R2 operations.
 * - GH_BOT_TOKEN, the token of the bot generating the purge messages.
 *
 * In addition, we expect the following command-line variables:
 *
 * 1. The name of the R2 bucket of interest.
 * 2. The full name (owner/repo) of the GitHub CI repository (i.e., the one containing this script).
 */

import S3 from 'aws-sdk/clients/s3.js';
import "isomorphic-fetch";
import * as utils from "./utils.js";
process.exitCode = 1;

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

if (process.argv.length - 2 != 2) {
    throw new Error("expected 2 arguments - BUCKET_NAME, REPO_NAME");
}
const bucket_name = process.argv[2];
const repo_name = process.argv[3];

// Only considering issues that were created by the same bot account.
let bot_res = await fetch("https://api.github.com/user", { headers: { Authorization: "Bearer " + token } });
let bot_id = (await bot_res.json()).login;
let list_url = "https://api.github.com/repos/" + repo_name + "/issues?direction=asc&creator=" + bot_id + "&state=open";

let redefine_latest = new Set;

while (1) {
    let res = await fetch(list_url, {
        headers: { 
            "Content-Type": "application/json",
            Authorization: "Bearer " + token
        } 
    });
    if (!res.ok) {
        throw new Error("failed to load all GitHub issues");
    }

    let body = await res.json();
    for (const issue of body) {
        if (issue.title != "purge project") {
            continue;
        } 

        let payload = JSON.parse(issue.body);
        let project = payload.project;
        let version = payload.version;

        if (payload.mode == "incomplete") {
            let lockpath = project + "/" + version + "/..LOCK";
            let lck = s3.headObject({ Bucket: bucket_name, Key: lockpath });

            let lock_exists = true;
            try {
                await lck.promise();
            } catch(e) {
                if (e.statusCode == 404) {
                    lock_exists = false;
                } else {
                    throw e;
                }
            }

            if (!lock_exists) {
                // If the lock no longer exists, then this issue is void,
                // so we just close it without issue.
                utils.closeIssue(repo_name, issue.number, token);
                console.log("Closing issue " + String(issue.number) + " for completed project")
                continue;
            }

            if (!(payload.delete_after > 0)) {
                throw new Error("invalid 'delete_after' for issue " + String(issue.number))
            }
            if (Date.now() < payload.delete_after) {
                console.log("Skipping issue " + String(issue.number) + " for in-progress project")
                continue;
            }

        } else if (payload.mode == "expiry") {
            if (!(payload.delete_after > 0)) {
                throw new Error("invalid 'delete_after' for issue " + String(issue.number))
            }
            if (Date.now() < payload.delete_after) {
                console.log("Skipping issue " + String(issue.number) + " for non-expired project")
                continue;
            }
            redefine_latest.add(project);

        } else {
            throw new Error("one of 'locked_only' or 'expires_in' must be set");
        }

        // Looping over list contents before deleting to avoid shenanigans with mutable read/write.
        let params = { Bucket: bucket_name, Prefix: project + "/" + version + "/" };

        let to_wipe = [];
        while (1) {
            let listing = s3.listObjectsV2(params)
            let info = await listing.promise();

            for (const f of info.Contents) {
                to_wipe.push(f.Key);
            }

            if (info.IsTruncated) {
                params.ContinuationToken = info.NextContinuationToken;
            } else {
                break;
            }
        }

        let wiped = to_wipe.map(x => s3.deleteObject({ Bucket: bucket_name, Key: x }).promise());
        await Promise.all(wiped);

        utils.closeIssue(repo_name, issue.number, token);
        console.log("Closing issue " + String(issue.number) + " for deleted project")
    }

    // Handling paginated listings.
    let by_links = {};
    let links = res.headers.get("link");
    if (links !== null) {
        let parsed = links.split(", ");
        for (const x of parsed) {
            let components = x.split("; ");
            let rel = components[1].replace(/rel="(.+)"/, (m, x) => x)
            let link = components[0].replace(/<(.+)>/, (m, x) => x)
            by_links[rel] = link;
        }
    }
    if ("next" in by_links) {
        list_url = by_links["next"];
    } else {
        break;
    }
}

// Redefine the latest versions.
for (const project of Array.from(redefine_latest)) {
    let params = { Bucket: bucket_name, Prefix: project + "/", Delimiter: "/" };

    let all_versions = [];
    while (1) {
        let listing = s3.listObjectsV2(params)
        let info = await listing.promise();

        for (const f of info.CommonPrefixes) {
            if (!f.Prefix.endsWith(".json")) {
                let fragments = f.Prefix.split("/");
                all_versions.push(fragments[fragments.length - 2]);
            }
        }

        if (info.IsTruncated) {
            params.ContinuationToken = info.NextContinuationToken;
        } else {
            break;
        }
    }

    let all_promises = all_versions.map(async version => {
        let lockpath = project + "/" + version + "/..LOCK";
        let lck = s3.headObject({ Bucket: bucket_name, Key: lockpath });

        let lock_exists = true;
        try {
            await lck.promise();
        } catch(e) {
            if (e.statusCode == 404) {
                lock_exists = false;
            } else {
                throw e;
            }
        }

        if (lock_exists) {
            return { version: "", index_time: -1 };
        }

        let rmeta = s3.getObject({ Bucket: bucket_name, Key: project + "/" + version + "/..revision.json" });
        let rinfo = await rmeta.promise().then(x => JSON.parse(x.Body.toString()));
        return { version: version, index_time: (new Date(rinfo.index_time)).getTime() };
    });

    let all_resolved = await Promise.all(all_promises);
    all_resolved.sort((a, b) => b.index_time - a.index_time);

    let latestpath = utils.getLatestPath(project);
    let latestinfo = {};
    if (all_resolved.length) {
        let chosen = all_resolved[0];
        latestinfo = utils.formatLatest(chosen.version, chosen.index_time);
    } else {
        latestinfo = utils.formatLatest("", -1);
    }
    await utils.putJson(s3, bucket_name, latestpath, latestinfo)
}

process.exitCode = 0;
