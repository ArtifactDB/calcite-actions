# GitHub actions for gypsum

## Overview

**gypsum** uses GitHub Actions for its various CI/CD tasks.
This currently includes:

- Indexing the metadata for a project, see [`src/index-project.js`](src/index-project.js).
- Purging expired or incomplete projects, see [`src/purge-projects.js`](src/purge-projects.js).

## Deployment

Deployment requires the specification of the R2 parameters:

- `R2_ACCOUNT_ID`, for the R2 account ID.
- `R2_ACCESS_KEY_ID`, for the access key ID.
- `R2_SECRET_ACCESS_KEY`, for the access secret.
- `GH_BOT_TOKEN`, for the GitHub PAT of the **gypsum** bot account.
