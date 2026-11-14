# Contributing

Thank you for helping. Artifact Atlas decides what may be removed from people's computers, so every change is held to a few firm rules.

## Before you start

- Read [AGENTS.md](AGENTS.md). Its safety rules apply to every change, whoever writes it: never run a scanned app, never delete without the Quarantine, never invent a link between a file and a session, never judge a file by its extension alone, never store conversation text.
- For anything larger than a fix, open an issue first so we can agree on the approach.

## Making a change

```bash
npm test       # must pass on Linux, macOS and Windows
npm start      # try it in the interface, on the built-in sample data
```

- Keep changes small and focused, with a test for the behaviour you add or fix.
- Build paths with `path.join` and compare with `path.sep`; tests run on Windows too.
- Write for people: plain words, short sentences, no internal names in the interface.

## Pull requests

Describe what changes for the person using the app, and how you checked it. Continuous integration builds and checks both apps on every pull request.
