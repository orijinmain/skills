# Codex Hook schemas

These JSON Schemas are vendored from the OpenAI Codex `rust-v0.144.5` release:

https://github.com/openai/codex/tree/rust-v0.144.5/codex-rs/hooks/schema/generated

Only the lifecycle events used by Corch are included. Run
`npm run generate:hook-types` after updating a schema. Do not update from the
`main` branch without reviewing release compatibility because unreleased
fields may appear there.

The vendored schemas remain licensed under the Apache License 2.0 in
`LICENSE.openai-codex`.
