"""Draw the README contributors image (SVG with embedded 2x avatars and usernames). Bots are skipped.
Usage: python .github/scripts/contributors_svg.py owner/repo out.svg   (GITHUB_TOKEN optional, raises rate limits)"""
import base64
import html
import json
import os
import sys
import urllib.parse
import urllib.request

AVATAR, GAP_X, GAP_Y, PER_ROW, LABEL = 64, 28, 34, 8, 13


def is_github_api(url):
    """Only send the token to https://api.github.com itself (exact host, not a substring of the URL)."""
    parts = urllib.parse.urlsplit(url)
    return parts.scheme == "https" and parts.hostname == "api.github.com"


def get(url, raw=False):
    req = urllib.request.Request(url, headers={"User-Agent": "kodudb-contributors"})
    if os.environ.get("GITHUB_TOKEN") and is_github_api(url):
        req.add_header("Authorization", f"Bearer {os.environ['GITHUB_TOKEN']}")
    with urllib.request.urlopen(req, timeout=30) as r:  # nosec B310 - fixed https GitHub URLs only
        data = r.read()
    return data if raw else json.loads(data)


def contributors(repo):
    people, page = [], 1
    while True:
        batch = get(f"https://api.github.com/repos/{repo}/contributors?per_page=100&page={page}")
        if not batch:
            return people
        people += [c for c in batch if c.get("type") == "User" and not c["login"].endswith("[bot]")]
        page += 1


def svg(people):
    """Pure renderer: [{'login', 'avatar': bytes}] -> SVG text."""
    cols = max(1, min(PER_ROW, len(people)))
    rows = max(1, -(-len(people) // PER_ROW))
    cell_w = AVATAR + GAP_X
    w, h = cols * cell_w, rows * (AVATAR + LABEL + GAP_Y)
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">',
           '<style>text{font:600 12px -apple-system,"Segoe UI",Helvetica,Arial,sans-serif;fill:#8b949e}</style>']
    for i, p in enumerate(people):
        x = (i % PER_ROW) * cell_w + GAP_X / 2
        y = (i // PER_ROW) * (AVATAR + LABEL + GAP_Y) + 4
        cid, login = f"c{i}", html.escape(p["login"])
        data = base64.b64encode(p["avatar"]).decode()
        out += [f'<clipPath id="{cid}"><circle cx="{x + AVATAR / 2}" cy="{y + AVATAR / 2}" r="{AVATAR / 2}"/></clipPath>',
                f'<image href="data:image/png;base64,{data}" x="{x}" y="{y}" width="{AVATAR}" height="{AVATAR}" '
                f'clip-path="url(#{cid})"><title>{login}</title></image>',
                f'<circle cx="{x + AVATAR / 2}" cy="{y + AVATAR / 2}" r="{AVATAR / 2 - 0.5}" fill="none" '
                'stroke="#8b949e" stroke-opacity="0.35"/>',
                f'<text x="{x + AVATAR / 2}" y="{y + AVATAR + LABEL + 4}" text-anchor="middle">{login}</text>']
    out.append("</svg>")
    return "\n".join(out)


def main(repo, path):
    people = [{"login": c["login"], "avatar": get(f"{c['avatar_url']}&s={AVATAR * 2}", raw=True)}
              for c in contributors(repo)]
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(svg(people))
    print(f"{len(people)} contributor(s) -> {path}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
