# GitHub actions for gypsum

## Overview

**gypsum** uses GitHub Actions for its various CI/CD tasks.
This currently includes:

- Validating and indexing the metadata for a project, see [`src/index-project.js`](src/index-project.js).
  This is triggered upon the [creation of an issue titled "upload complete"](.github/workflows/index-project.yaml) through a recognized bot account.
- Purging expired or incomplete projects, see [`src/purge-projects.js`](src/purge-projects.js).
  This is triggered on [a daily schedule for all issues titled "purge project"](.github/workflows/purge-projects.yaml).

The [**gypsum** worker](https://github.com/ArtifactDB/gypsum-worker) uses the bot account's token to create issues to trigger each Action.

## Deployment instructions

To deploy, clone/fork this repository and apply the following modifications:

- In [`index-project.yaml`](.github/workflows/index-project.yaml):
  - Replace `'ArtifactDB-bot'` with the name of your bot account.
- In [`config.sh`](config.sh):
  - Replace `CF_ACCOUNT_ID` with your Cloudflare account ID.
  - Replace `SCHEMA_BUNDLE_URL` with a URL to the desired schema bundle.
  - Replace `R2_BUCKET_NAME` with the name of your R2 bucket.

Several secrets must be defined for the Actions (see the Settings > Secrets > Actions tab):

- `R2_ACCESS_KEY_ID`, for the access key ID.
- `R2_SECRET_ACCESS_KEY`, for the access secret.
- `GH_BOT_TOKEN`, for the GitHub personal access token of the bot account.
  This should have at least public repo privileges.

For forks, we have to re-enable some features:

- Turn the Issues back on (in Settings > General).
- Re-enable the Actions in the "Actions" tab.
- Re-enable the scheduled "Purge gypsum projects" workflow.

And that's it.
Make sure you use the full name of your repository (i.e., `OWNER/REPO`) in the **gypsum** worker's configuration. 
