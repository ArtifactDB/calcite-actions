# GitHub actions for calcite

This is a fork of the [**gypsum-actions**](https://github.com/ArtifactDB/gypsum-actions) repository that is customized for the [**calcite**](https://github.com/ArtifactDB/calcite-worker) demonstrator API.
The only changes to the code involve altering [`config.sh`](config.sh) to point to a different set of schemas and a different R2 bucket.
(We're using the same bot account as **gypsum**, so no need to change the Actions workflow.)

Check out [these instructions](https://github.com/ArtifactDB/gypsum-actions#deployment-instructions) for more details. 
