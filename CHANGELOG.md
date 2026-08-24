# Changelog

## Unreleased

- Renamed `OPENAI_API_BASE_URL` to `OPENAI_BASE_URL` and `OPENAI_MODEL_DEFAULT` to `OPENAI_MODEL`, the standard names of the OpenAI SDKs.


## 2026-08-10: 1.2.0

- `OPENAI_MODEL_IGNORE` leaves models out of the menu, as a comma-separated list of identifiers where `*` stands for any run of characters.


## 2026-08-09: 1.1.0

- `OPENAI_MODEL_ALIASES` gives the models display names, as a comma-separated list of `id=alias` pairs.
- `OPENAI_MODEL_DEFAULT` names the model a first visit starts on, by identifier or by alias.

## 2026-08-07: 1.0.0

Initial release.
