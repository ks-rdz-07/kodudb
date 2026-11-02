"""Draw README count badges (clones, views, stars, forks, Docker pulls) as SVG files.

GitHub keeps only 14 days of clone and view traffic, so daily counts are merged into history.json and the
badges show totals since tracking started.

Usage: python .github/scripts/repo_stats.py owner/repo out_dir [history.json] [docker_image ...]
  GITHUB_TOKEN   repository metadata (stars, forks)
  TRAFFIC_TOKEN  clone and view traffic (needs a token with Administration: read on the repository); optional
  python .github/scripts/repo_stats.py --self-test
"""
import html
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

API = "https://api.github.com"


def get(url, token=None):
    req = urllib.request.Request(url, headers={"User-Agent": "kodudb-stats", "Accept": "application/vnd.github+json"})
    parts = urllib.parse.urlsplit(url)
    if token and parts.scheme == "https" and parts.hostname == "api.github.com":  # never send tokens elsewhere
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=30) as r:  # nosec B310 - fixed https URLs only
        return json.loads(r.read())


def merge_daily(history, kind, days):
    """Keep the newest value per day: today's count grows until the day ends."""
    bucket = history.setdefault(kind, {})
    for d in days:
        bucket[d["timestamp"][:10]] = {"count": d["count"], "uniques": d["uniques"]}
    return history


def totals(history, kind):
    days = history.get(kind, {}).values()
    return sum(d["count"] for d in days), sum(d["uniques"] for d in days)


def short(n):
    """1234 -> 1.2k, 1250000 -> 1.3M."""
    for unit, size in (("M", 1_000_000), ("k", 1_000)):
        if n >= size:
            v = f"{n / size:.1f}".rstrip("0").rstrip(".")
            return f"{v}{unit}"
    return str(n)


def text_width(s):
    """Approximate Verdana 11px advance widths, close enough for badge layout."""
    narrow, wide = set("il.,:;|!'1 "), set("mwMW@%")
    return sum(4 if c in narrow else 10 if c in wide else 7 for c in s) + 10


def badge(label, value, color="#e5484d"):
    """Flat two-part badge, like the common README badge style, as standalone SVG text."""
    lw, vw = text_width(label), text_width(value)
    w = lw + vw
    label, value = html.escape(label), html.escape(value)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="20" role="img" aria-label="{label}: {value}">'
        f'<title>{label}: {value}</title><clipPath id="r"><rect width="{w}" height="20" rx="3"/></clipPath>'
        f'<g clip-path="url(#r)"><rect width="{lw}" height="20" fill="#555"/>'
        f'<rect x="{lw}" width="{vw}" height="20" fill="{color}"/></g>'
        f'<g fill="#fff" text-anchor="middle" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11">'
        f'<text x="{lw / 2}" y="14">{label}</text><text x="{lw + vw / 2}" y="14">{value}</text></g></svg>'
    )


def docker_pulls(image):
    try:
        return get(f"https://hub.docker.com/v2/repositories/{image}/").get("pull_count", 0)
    except urllib.error.HTTPError:
        return 0


def main(repo, out_dir, history_path=None, images=()):
    gh, traffic = os.environ.get("GITHUB_TOKEN"), os.environ.get("TRAFFIC_TOKEN")
    history = {}
    if history_path and os.path.exists(history_path):
        with open(history_path, encoding="utf-8") as f:
            history = json.load(f)
    meta = get(f"{API}/repos/{repo}", gh)
    if traffic:
        merge_daily(history, "clones", get(f"{API}/repos/{repo}/traffic/clones", traffic)["clones"])
        merge_daily(history, "views", get(f"{API}/repos/{repo}/traffic/views", traffic)["views"])
    clones, cloners = totals(history, "clones")
    views, _ = totals(history, "views")
    pulls = sum(docker_pulls(i) for i in images)
    tracked = bool(history.get("clones"))
    files = {
        "clones.svg": badge("clones", short(clones) if tracked else "n/a"),
        "cloners.svg": badge("unique cloners", short(cloners) if tracked else "n/a"),
        "views.svg": badge("views", short(views) if tracked else "n/a", "#3e63dd"),
        "stars.svg": badge("stars", short(meta["stargazers_count"]), "#ffc53d"),
        "forks.svg": badge("forks", short(meta["forks_count"]), "#30a46c"),
        "docker-pulls.svg": badge("docker pulls", short(pulls), "#2496ed"),
    }
    os.makedirs(out_dir, exist_ok=True)
    for name, content in files.items():
        with open(os.path.join(out_dir, name), "w", encoding="utf-8") as f:
            f.write(content)
    with open(os.path.join(out_dir, "history.json"), "w", encoding="utf-8") as f:
        json.dump(history, f, indent=1, sort_keys=True)
    print(f"clones={clones} cloners={cloners} views={views} stars={meta['stargazers_count']} forks={meta['forks_count']} pulls={pulls}")


def self_test():
    h = merge_daily({}, "clones", [{"timestamp": "2026-11-01T00:00:00Z", "count": 5, "uniques": 2}])
    h = merge_daily(h, "clones", [{"timestamp": "2026-11-01T00:00:00Z", "count": 7, "uniques": 3},
                                  {"timestamp": "2026-11-02T00:00:00Z", "count": 1, "uniques": 1}])
    assert totals(h, "clones") == (8, 4), totals(h, "clones")  # same day replaced, not added
    assert totals(h, "views") == (0, 0)
    assert [short(n) for n in (0, 999, 1000, 1234, 1_260_000)] == ["0", "999", "1k", "1.2k", "1.3M"]
    b = badge("clones", "1.2k")
    assert b.startswith("<svg") and "clones: 1.2k" in b and b.endswith("</svg>")
    assert "&lt;x&gt;" in badge("<x>", "1"), "labels are escaped"
    print("self-test ok")


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-test"]:
        self_test()
    else:
        main(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None, sys.argv[4:])
