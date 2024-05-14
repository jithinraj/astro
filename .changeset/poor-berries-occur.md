---
"astro": minor
---

Adds experimental support for the `astro:env` API. It lets you define a type-safe schema for your environments variables, and where they should be available (on the server or the client).

Start by declaring a schema in your Astro config in `experimental.env.schema`. Use the `envField` help to make your life easier:

```js
// astro.config.mjs
import { defineConfig, envField } from "astro/config"

export default defineConfig({
    experimental: {
        env: {
            schema: {
                PUBLIC_API_URL: envField.string({ context: "client", access: "public", optional: true }),
                PUBLIC_PORT: envField.number({ context: "server", access: "public", default: 4321 }),
                API_SECRET: envField.string({ context: "server", access: "secret" }),
            }
        }
    }
})
```

There are currently 3 data types supported: strings, numbers and booleans.

There are also 3 kinds of variables:

- **Public client variables**: Those variables end up in your final client and server bundle and can be accessed both client and server through the `astro:env/client` module:

    ```js
    import { PUBLIC_API_URL } from "astro:env/client"
    ```

- **Public server variables**: Those variables end up in your final server bundle and can be accessed on the server through the `astro:env/server` module:

    ```js
    import { PUBLIC_PORT } from "astro:env/server"
    ```

- **Secret server variables**: Those variables are not part of your final bundle and can be accessed on the server through the `astro:env/server` module:

    ```js
    import { getSecret } from "astro:env/server"

    const API_SECRET = getSecret("API_SECRET") // typed
    const SECRET_THAT_MAY_EXIST = getSecret("SECRET_THAT_MAY_EXIST") // string | undefined
    ```

For a complete overview, and to give feedback on this experimental API, see the [Astro Env RFC](https://github.com/withastro/roadmap/blob/feat/astro-env-rfc/proposals/0046-astro-env.md).