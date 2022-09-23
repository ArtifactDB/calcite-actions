# GitHub actions for gypsum

## Overview

**gypsum** uses GitHub Actions for its various CI/CD tasks.
This currently includes:

- Indexing the metadata for a project, see [`src/index_project.js`](src/index_project.js).

## Deployment

Deployment requires the specification of the R2 parameters:

- `R2_ACCOUNT_ID`, for the R2 account ID.
- `R2_ACCESS_KEY_ID`, for the access key ID.
- `R2_SECRET_ACCESS_KEY`, for the access secret.
