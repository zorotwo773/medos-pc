"""Fetch a rendered AMBOSS article from the running backend and print
image/asset-related snippets to figure out what's actually being served."""
from __future__ import annotations
import re
import sys
import urllib.request

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000/amboss/article/3"

html = urllib.request.urlopen(URL).read().decode("utf-8", "replace")
print(f"ARTICLE SIZE: {len(html):,} bytes")
print(f"URL        : {URL}")

print("\n-- first 3 <img ...> tags --")
for tag in re.findall(r"<img[^>]*>", html)[:3]:
    print(tag[:240])

print("\n-- first 10 data-source attrs --")
for d in re.findall(r'data-source="[^"]{1,80}"', html)[:10]:
    print(d)

print("\n-- any ../Images/ refs? --")
print(re.findall(r'\.\./Images/[^"\s]{1,60}', html)[:5] or "<none>")

print("\n-- any /amboss/image/ refs? --")
print(re.findall(r'/amboss/image/[^"\s]{1,60}', html)[:5] or "<none>")

print("\n-- any /amboss/Images/ refs? --")
print(re.findall(r'/amboss/Images/[^"\s]{1,60}', html)[:5] or "<none>")

print("\n-- data-content blob count --")
print(len(re.findall(r'data-content="[A-Za-z0-9+/=]{40,}', html)))

first_token = re.search(r'data-source="([^"]+)"', html)
if first_token:
    token = first_token.group(1)
    idx = html.find(f'data-source="{token}"')
    print("\n-- snippet around first data-source token --")
    print(html[max(0, idx - 500):idx + 1500])
