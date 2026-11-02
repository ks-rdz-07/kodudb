"""Set the Docker Hub short description and overview of each image from docs/docker/.

Usage: python .github/scripts/dockerhub_overview.py <namespace> <dir>     (DOCKERHUB_USERNAME, DOCKERHUB_TOKEN)
       python .github/scripts/dockerhub_overview.py --check <dir>        (validate only, no network)
<dir>/descriptions.json maps repository -> short description; <dir>/<repository>.md is its overview.
"""
import json
import os
import sys
import urllib.error
import urllib.request

HUB = "https://hub.docker.com/v2"
SHORT_MAX, FULL_MAX = 100, 25000  # Docker Hub limits


def load(directory):
    with open(os.path.join(directory, "descriptions.json"), encoding="utf-8") as f:
        short = json.load(f)
    repos = {}
    for repo, desc in short.items():
        with open(os.path.join(directory, repo + ".md"), encoding="utf-8") as f:
            full = f.read()
        if len(desc) > SHORT_MAX:
            raise SystemExit(f"{repo}: short description is {len(desc)} characters (max {SHORT_MAX})")
        if len(full) > FULL_MAX:
            raise SystemExit(f"{repo}: overview is {len(full)} characters (max {FULL_MAX})")
        repos[repo] = (desc, full)
    return repos


def call(method, url, body, token=None):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method=method,
                                 headers={"Content-Type": "application/json", "User-Agent": "kodudb-release"})
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:  # nosec B310 - fixed https Docker Hub URL
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:300]
        raise SystemExit(f"{method} {url} -> {e.code}: {detail}")


def main(namespace, directory):
    repos = load(directory)
    token = call("POST", f"{HUB}/users/login", {"username": os.environ["DOCKERHUB_USERNAME"],
                                                 "password": os.environ["DOCKERHUB_TOKEN"]})["token"]
    for repo, (desc, full) in repos.items():
        call("PATCH", f"{HUB}/repositories/{namespace}/{repo}/", {"description": desc, "full_description": full}, token)
        print(f"updated {namespace}/{repo} ({len(desc)} + {len(full)} characters)")


if __name__ == "__main__":
    if sys.argv[1] == "--check":
        for repo, (desc, full) in load(sys.argv[2]).items():
            print(f"ok {repo}: {len(desc)} / {SHORT_MAX}, {len(full)} / {FULL_MAX}")
    else:
        main(sys.argv[1], sys.argv[2])
