import urllib.request as u
for path in [
    "/amboss/image/big_614c1fcd570b8.jpg",
    "/amboss/Images/big_614c1fcd570b8.jpg",
    "/amboss/article/3",
    "/amboss/static/base.css",
    "/amboss/static/a.min.js",
]:
    try:
        r = u.urlopen("http://127.0.0.1:8000" + path)
        size = len(r.read())
        ct = r.headers.get("content-type")
        print(f"{path:55s} -> {r.status}  {size:>8} bytes  {ct}")
    except Exception as e:
        print(f"{path:55s} -> ERROR {e}")
