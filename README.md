# Session Usage for Claude Code

A Claude Code mod that shows where a session's tokens, cost and time went.

- **Overview**: cost at API list prices, input tokens, active time, context fill, and this session's share of your 5-hour and weekly limits.
- **Tokens vs. cost**: why caching matters. Cache reads are most of the tokens but a small part of the cost.
- **Over time**: cost per turn, context size and cost per request, the running total, and cache rebuilds.
- **By content**: what each kind of content cost (code read or written, terminal commands and output, scripts, web, skills, reminders, thinking, replies, …). Click a kind to see what it was made of: which files, commands or skills.
- **Time**: Claude vs. tools vs. waiting for you, per turn, per tool, and the slowest calls.
- **Filter**: pick turns and/or kinds of content; every chart follows.
- **Footer button** under the chat input (desktop app): this session's share of the 5-hour limit and its cost. A click opens a short summary above the input, with a way on to the full pane.

Open it with `/session-usage`. `/session-usage <session-id>` analyzes an earlier session; `/session-usage export` writes a Markdown report.

## Install

At the prompt of a Claude Code session in a terminal (`claude`):

```
/plugin install session-insights --marketplace Thoress/ClaudeSessionUsage
```

Answer `y` to add the marketplace, then pick a scope (user: every session). The repository is private, so git on this computer needs access to it. The desktop app's sessions load the mod once it is installed at the user scope.

To update later: `claude plugin update session-insights`, then `/reload-plugins`.

## Develop

Add this folder as a marketplace and install from it. The installed mod is then read from the folder itself, so an edit takes effect after `/reload-plugins`:

```
claude plugin marketplace add F:\Programmieren\AI\ClaudeSessionUsage
claude plugin install session-insights@claude-session-usage
```

Check and test:

```
claude plugin validate .
claude plugin test .
```

## How it measures

- **Tokens and cost** come from the session's transcript (`~/.claude/projects/…/<session>.jsonl`): the API's own usage figures per request, priced at first-party list prices.
- **By content**: the growth of the context between two requests is exact. It is shared out over the content added in between by character count, so the split per kind is a close estimate.
- **Time** comes from row timestamps: model time runs from a request's input to its last streamed block, tool time from the call to its result.
- **Limits**: how full each window is comes from the API, for the whole account. This session's share is that figure split by cost across every local Claude Code session inside the window. Usage elsewhere (claude.ai, other devices) is not in the local transcripts and makes the share read high. The first measurement scans a week of transcripts with a native search (`hooks/scan.ps1` on Windows, `grep` elsewhere); later ones only rescan changed files.
