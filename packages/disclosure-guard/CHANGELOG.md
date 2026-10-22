# Changelog

All notable changes to this package are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Standalone packaging: self-contained `tsconfig.standalone.json`, package-local `vitest.config.ts`, `typecheck` and `prepack` scripts, devDependencies, `package-lock.json` for `npm ci`, repository metadata, GitHub Actions CI, and this changelog.

## [0.1.0] - 2026-10-22

First version, extracted from the Stand-In monorepo (`packages/disclosure-guard`).

### Added

- `expand`: single-pass `{{fact:key}}` substitution with `share` / `confirm` / `never` tiers. Withheld, unknown and malformed slots become a hand-off phrase.
- `scanOutbound`: output DLP for `never` fact values, unapproved `confirm` values, Luhn-valid card numbers, Aadhaar-shaped numbers, OTP-like and CVV-like digits near a keyword, and spoken passwords. Spoken digits (`four two one nine`, `double five`, `oh`) and Unicode look-alikes are normalised before matching. Reasons never contain the matched value.
- `guardUtterance`: `expand` followed by `scanOutbound`. Never throws; returns a safe fallback and a `blocked_utterance` record when blocked or when input is invalid.
- `classifyInbound`: flags callee requests for OTP, PIN, password, CVV, card, Aadhaar, remote-access apps (`never` tier) and payments or UPI (`confirm` tier), plus prompt-injection phrases.
- `mask`: transcript masking with `•••`.
- `assignTier`, `isSpeakable`, `luhnValid`, and zod schemas for every input and output.
