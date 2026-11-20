# Working on this repository

- **Never put Claude chat session links** (claude.ai/code/session_… or any other Claude
  conversation URL) in commit messages, pull requests, issues, comments, code or docs — anywhere
  on GitHub.
- `npm test` (offline suite) must pass. Phone mode's brain is either Gemini (`lib/gemini.js`) or
  ARC (`lib/arc.js`, same interface); a change to one must keep the other working.
