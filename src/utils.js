export async function getJson(s3, bucket_name, key) {
    let req = s3.getObject({ Bucket: bucket_name, Key: project + "/" + version + "/..expiry.json" });
    let res = null;
    try {
        res = await exp_req.promise();
    } catch (e) {
        if (e.statusCode == 404) {
            return null;
        }
        throw e;
    }

    return JSON.parse(res.Body.toString());
}

export async function putJson(s3, bucket_name, key, value) {
    let res = s3.putObject({ 
        Bucket: bucket_name, 
        Key: key,
        Body: JSON.stringify(value),
        ContentType: "application/json" 
    });
    return res.promise();
}
