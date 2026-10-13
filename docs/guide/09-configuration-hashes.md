# 9. Configuration hashes

[Contents](README.md) · Previous: [8. Locales](08-locales.md) · Next: [10. Editor support](10-editor-support.md)

Every configuration file of an app built by `defineApp` has a content hash, so a call can be tied to the exact configuration it ran under.

- A file's hash is SHA-256 over its parsed content as JSON (object keys in the order written at every level, arrays in order, no whitespace). A comment, a blank line, flow or block style or another quoting style does not change it; a changed value does, and so does reordering keys, since a key's place is meaning (the order of `slots.yaml` is the order of the app's slots).
- The combined hash is SHA-256 over the lines `<file>:<hash>`, sorted by file name and joined with newlines. It changes when any file changes, or one is added or removed. Locale files are in it by path (`locale/es/prompts.yaml`, `locale/es/slots.yaml`, `locale/es/intents.yaml`).
- They are on the app as `App.configHashes` (`app` for the combined hash, `files` for each file).
- The `call_started` audit row records the combined hash as `config` and the per-file lines as `configFiles`, so the row alone is enough to recompute and verify the combined hash.
- Every trace record carries the combined hash as `configHash`, and the console shows its first eight characters as `config <8 chars>`.
- An app with a knowledge base has a line for each `kb/` file it is read from (kb.yaml, topics, passages, sources and the locale files; not drafts, rejected drafts, the approvals log or the vector index), so the combined hash changes when an approved answer or its source does ([12.12](12-the-knowledge-base.md#1212-what-is-recorded)).
- They are never sent to the model.

An app that is not built from a folder has no hashes, and its rows are as they were.

The hashes changed format in this release: a file's hash used to be taken over its content with object keys sorted, and now keeps them in the order written. A `config` or `configFiles` hash in a `call_started` row written before the change is not comparable with one written after it, even for the same files; compare hashes only between rows written by the same version.
