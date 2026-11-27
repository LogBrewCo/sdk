# SDK contract

Every LogBrew SDK follows the rules in this folder.

- `event-batch.schema.json` is the JSON Schema for each event batch that an SDK sends to LogBrew.

## Server API key

A server SDK finds its API key in this order:

1. A key that the code passes to the client. An empty or blank key counts as no key.
2. The `LOGBREW_SERVER_API_KEY` environment variable, when it is not empty or blank.
3. No key. The SDK does not create the client and reports a configuration error that names `LOGBREW_SERVER_API_KEY`.

An app can send its first event with only this environment variable and no key in its code:

```sh
export LOGBREW_SERVER_API_KEY="<server API key>"
```

Browser and mobile SDKs never read `LOGBREW_SERVER_API_KEY`, because a server key must not go into a browser bundle or a mobile app. These SDKs get their key from code.
