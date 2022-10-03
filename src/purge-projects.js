/**
 * Purge projects that have expired, either due to exceeding the expiry time or
 * being incomplete uploads that have passed the upload timeout.
 *
 * Run 'node --experimental-vm-modules src/purge-projects.js --help' for
 * details on the expected arguments.
 */

import yargs from "yargs";
import { hideBin } from 'yargs/helpers';

import S3 from 'aws-sdk/clients/s3.js';
import "isomorphic-fetch";

import * as utils from "./utils.js";
import * as internal from "./internal.js";

process.exitCode = 1;

const args = yargs(hideBin(process.argv))
    .option("cfid", {
        describe: "Cloudflare account ID",
        type: "string"
    })
    .option("r2key", {
        describe: "R2 API access key ID",
        type: "string"
    })
    .option("r2secret", {
        describe: "R2 API secret access key",
        type: "string"
    })
    .option("r2bucket", {
        describe: "R2 bucket name",
        type: "string"
    })
    .option("ghrepo", {
        describe: "GitHub repository name (OWNER/REPO)",
        type: "string"
    })
    .option("ghtoken", {
        describe: "GitHub bot personal access token",
        type: "string"
    })
    .demandOption(["cfid", "r2key", "r2secret", "r2bucket", "ghtoken", "ghrepo" ])
    .help()
    .argv;

const s3 = new S3({
    endpoint: "https://" + args.cfid + ".r2.cloudflarestorage.com",
    accessKeyId: args.r2key,
    secretAccessKey: args.r2secret,
    signatureVersion: 'v4',
});

const token = args.ghtoken;
const bucket_name = args.r2bucket;
const repo_name = args.ghrepo;

// Only considering issues that were created by the same bot account.
let bot_res = await fetch("https://api.github.com/user", { headers: { Authorization: "Bearer " + token } });
let bot_id = (await bot_res.json()).login;
let list_url = "https://api.github.com/repos/" + repo_name + "/issues?direction=asc&creator=" + bot_id + "&state=open";

let to_delete = {};
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
            let lockpath = internal.lock(project, version);
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
                console.log("Closing issue " + String(issue.number) + " for completed project '" + project + "', version '" + version + "'")
                continue;
            }

            if (!(payload.delete_after > 0)) {
                throw new Error("invalid 'delete_after' for issue " + String(issue.number))
            }
            if (Date.now() < payload.delete_after) {
                console.log("Skipping issue " + String(issue.number) + " for in-progress project '" + project + "', version '" + version + "'")
                continue;
            }

        } else if (payload.mode == "expiry") {
            if (!(payload.delete_after > 0)) {
                throw new Error("invalid 'delete_after' for issue " + String(issue.number))
            }
            if (Date.now() < payload.delete_after) {
                console.log("Skipping issue " + String(issue.number) + " for non-expired project '" + project + "', version '" + version + "'")
                continue;
            }
            redefine_latest.add(project);

        } else {
            throw new Error("one of 'locked_only' or 'expires_in' must be set in issue " + String(issue.number));
        }

        if (!(project in to_delete)) {
            to_delete[project] = [];
        }
        to_delete[project].push({ version: version, issue: issue.number });
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

// Redefine the latest versions before deleting. This is necessary to avoid a
// brief period where the latest version points to a deleted entry.
for (const project of Array.from(redefine_latest)) {
    let params = { Bucket: bucket_name, Prefix: project + "/", Delimiter: "/" };
    let invalid = new Set(to_delete[project].map(x => x.version));

    let all_versions = [];
    while (1) {
        let listing = s3.listObjectsV2(params)
        let info = await listing.promise();

        for (const f of info.CommonPrefixes) {
            if (!f.Prefix.endsWith(".json")) {
                let fragments = f.Prefix.split("/");
                let curversion = fragments[fragments.length - 2];
                if (!invalid.has(curversion)) {
                    all_versions.push(curversion);
                }
            }
        }

        if (info.IsTruncated) {
            params.ContinuationToken = info.NextContinuationToken;
        } else {
            break;
        }
    }

    let all_promises = all_versions.map(async version => {
        let lockpath = internal.lock(project, version);
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

        let rmeta = s3.getObject({ Bucket: bucket_name, Key: internal.versionMetadata(project, version) });
        let rinfo = await rmeta.promise().then(x => JSON.parse(x.Body.toString()));
        return { version: version, index_time: (new Date(rinfo.index_time)).getTime() };
    });

    let all_resolved = await Promise.all(all_promises);
    all_resolved.sort((a, b) => b.index_time - a.index_time);

    let latestinfo = {};
    if (all_resolved.length) {
        let chosen = all_resolved[0];
        latestinfo = utils.formatLatest(chosen.version, chosen.index_time);
    } else {
        latestinfo = utils.formatLatest("", -1);
    }

    await utils.putJson(s3, bucket_name, internal.latestAll(project), latestinfo)
    console.log("Updating latest version for '" + project + "'");
}

// Finally going on to delete all the entries.
for (const [project, jobs] of Object.entries(to_delete)) {
    for (const info of jobs) {
        let version = info.version;

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

        utils.closeIssue(repo_name, info.issue, token);
        console.log("Closing issue " + String(info.issue) + " for deleted project '" + project + "', version '" + version + "'");
    }
}

process.exitCode = 0;
