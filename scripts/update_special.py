#!/usr/bin/env python3
"""
Fetch public RSS/Atom (RSSHub-compatible bases), pick the newest item whose text
contains 'special' or 'specials', write special.json for static hosting.

Also reads optional facebook-post-urls.txt (repo root): Facebook share/post URLs
fetched via curl + Open Graph when RSS fails (Meta often blocks Python urllib).

Uses retries and atomic writes so CI and the site never see a half-written file.
"""

from __future__ import annotations

import html as html_lib
import json
import os
import re
import shutil
import subprocess
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any

KEYWORDS = ("special of the day", "specials", "special")

DEFAULT_RSSHUB_BASES = (
    "https://rsshub.app",
    "https://rsshub.rssforever.com",
)

FB_PAGE = os.environ.get("FACEBOOK_PAGE_ID", "elsombreroexpress")
IG_USER = os.environ.get("INSTAGRAM_USERNAME", "").strip()
# Default restaurant day boundary (Mountain Time / Roadrunner Pkwy area).
LOCAL_TZ = os.environ.get("SPECIAL_TZ", "America/Denver")

FETCH_RETRIES = int(os.environ.get("FETCH_RETRIES", "3"))
FETCH_BACKOFF = float(os.environ.get("FETCH_BACKOFF", "2.0"))
FETCH_TIMEOUT = int(os.environ.get("FETCH_TIMEOUT", "45"))

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
)
# Facebook often serves a ~1.5KB stub to full "Safari/537.36" curl clients; shorter UA gets real HTML.
FB_HTML_FETCH_UA = os.environ.get(
    "FB_HTML_FETCH_UA",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0",
)

ATOM_NS = {"a": "http://www.w3.org/2005/Atom"}

# Optional: one Facebook /share/p/... or post URL per line (see facebook-post-urls.example.txt).
_FB_URLS_FILE = "facebook-post-urls.txt"


def _repo_root() -> str:
    return os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def _read_facebook_share_urls() -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    raw_env = os.environ.get("FACEBOOK_POST_URLS", "") or os.environ.get("FACEBOOK_SHARE_URLS", "")
    for raw in raw_env.split(","):
        u = raw.strip()
        if u and u not in seen:
            seen.add(u)
            out.append(u)
    path = os.path.join(_repo_root(), _FB_URLS_FILE)
    if os.path.isfile(path):
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if line not in seen:
                    seen.add(line)
                    out.append(line)
    return out


def _meta_property(html: str, prop: str) -> str | None:
    """Read <meta property=\"og:...\" content=\"...\"> (either attribute order)."""
    prop_re = re.escape(prop)
    patterns = [
        rf'<meta\s+property=["\']{prop_re}["\']\s+content=(["\'])(.*?)\1',
        rf'<meta\s+content=(["\'])(.*?)\1\s+property=["\']{prop_re}["\']',
        rf'<meta\s+name=["\']{prop_re}["\']\s+content=(["\'])(.*?)\1',
    ]
    for pat in patterns:
        m = re.search(pat, html, re.I | re.DOTALL)
        if m:
            raw = m.group(2)
            return html_lib.unescape(raw).strip() or None
    return None


def _fetch_html_curl(url: str, timeout: int | None = None) -> str | None:
    """
    Meta often returns HTTP 400 to Python urllib; Windows/macOS curl usually gets HTML.
    """
    if timeout is None:
        timeout = min(FETCH_TIMEOUT, 35)
    exe = "curl.exe" if os.name == "nt" else "curl"
    curl_path = shutil.which(exe) or shutil.which("curl")
    if not curl_path:
        return None
    try:
        r = subprocess.run(
            [
                curl_path,
                "-sL",
                "-A",
                FB_HTML_FETCH_UA,
                "--max-time",
                str(timeout),
                "-H",
                "Accept: text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
                "-H",
                "Accept-Language: en-US,en;q=0.9,es;q=0.8",
                url,
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout + 15,
            check=False,
        )
        if r.returncode != 0 or not (r.stdout and r.stdout.strip()):
            return None
        return r.stdout
    except (subprocess.TimeoutExpired, OSError, ValueError):
        return None


def _fetch_html_once(url: str, timeout: int | None = None) -> str | None:
    if timeout is None:
        timeout = min(FETCH_TIMEOUT, 30)
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9,es;q=0.8",
            # identity avoids gzip binary decode edge cases in urllib on some Windows setups
            "Accept-Encoding": "identity",
            "Connection": "close",
            "Cache-Control": "no-cache",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            charset = resp.headers.get_content_charset() or "utf-8"
            text = raw.decode(charset, errors="replace")
            if text.startswith("\ufeff"):
                text = text[1:]
            return text
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError):
        return None


def _extract_title_tag(html: str) -> str:
    m = re.search(r"<title[^>]*>([^<]*)</title>", html, re.I)
    if not m:
        return ""
    return html_lib.unescape(m.group(1).strip())


def _facebook_url_variants(url: str) -> list[str]:
    """Try desktop + mobile host; keep query stripped for consistency."""
    u = url.strip()
    if not u:
        return []
    variants = [u]
    if "m.facebook.com" not in u and "facebook.com" in u:
        variants.append(re.sub(r"(?i)^https?://(www\.)?facebook\.com/", "https://m.facebook.com/", u))
    return list(dict.fromkeys(variants))


def _og_item_from_facebook_url(page_url: str) -> dict[str, Any] | None:
    """
    Parse Open Graph tags from a public Facebook share/post HTML page.
    Works when Meta serves og:title / og:description to the request (often true from home IPs).
    """
    html_text: str | None = None
    used_url = page_url
    for variant in _facebook_url_variants(page_url):
        print(f"[update_special] facebook-og: trying ...", flush=True)
        print(f"  {variant}", flush=True)
        html_text = _fetch_html_once(variant)
        if not html_text or len(html_text) < 800 or "og:title" not in html_text.lower():
            curl_html = _fetch_html_curl(variant)
            if curl_html:
                print(f"[update_special]   curl got {len(curl_html)} bytes", flush=True)
                html_text = curl_html
        if html_text and len(html_text) > 800 and "og:title" in html_text.lower():
            used_url = variant
            break
        print("[update_special]   no usable HTML (urllib blocked? install curl)", flush=True)

    if not html_text:
        return None

    title = _meta_property(html_text, "og:title") or ""
    desc = (
        _meta_property(html_text, "og:description")
        or _meta_property(html_text, "twitter:description")
        or ""
    )
    image = _meta_property(html_text, "og:image") or _meta_property(html_text, "twitter:image")
    canonical = _meta_property(html_text, "og:url") or page_url
    pub_raw = _meta_property(html_text, "article:published_time") or _meta_property(html_text, "og:updated_time") or ""

    if not _item_matches(title, desc):
        doc_title = _extract_title_tag(html_text)
        if doc_title and _item_matches(doc_title, desc):
            title = doc_title
        elif doc_title and _item_matches(doc_title, ""):
            title = doc_title
        else:
            print("[update_special]   og/title text did not contain special/specials", flush=True)
            return None

    t, d = title.strip(), desc.strip()
    if t and d and t != d:
        caption = f"{t}\n{d}"
    elif d:
        caption = d
    else:
        caption = t

    post_title = t or "Facebook post"
    for line in (d or "").split("\n"):
        ls = line.strip()
        if ls and "special" in ls.lower():
            post_title = ls
            break
    if post_title == (t or "Facebook post") and t and "special" in t.lower():
        post_title = t

    dt = _parse_pub_date(pub_raw)
    if dt is None:
        dt = datetime.now(timezone.utc)

    print(f"[update_special]   og match ({len(caption)} chars caption)", flush=True)
    return {
        "network": "facebook",
        "title": post_title,
        "link": canonical.strip() or page_url.strip(),
        "publishedRaw": pub_raw,
        "published": dt.isoformat(),
        "publishedSort": dt.timestamp(),
        "captionText": caption,
        "image": image,
        "feedUrl": f"facebook-og:{used_url}",
    }


def _bases() -> list[str]:
    raw = os.environ.get("RSSHUB_BASE", "").strip()
    if raw:
        return [b.strip().rstrip("/") for b in raw.split(",") if b.strip()]
    return list(DEFAULT_RSSHUB_BASES)


def _feed_urls() -> list[tuple[str, str]]:
    paths: list[tuple[str, str]] = [
        ("facebook", f"/facebook/page/{FB_PAGE}"),
    ]
    if IG_USER:
        paths.extend(
            [
                ("instagram", f"/instagram/user/{IG_USER}"),
                ("instagram", f"/instagram/2/user/{IG_USER}"),
            ]
        )
    out: list[tuple[str, str]] = []
    for base in _bases():
        for net, path in paths:
            out.append((net, f"{base}{path}"))
    return out


def _fetch_once(url: str, timeout: int | None = None) -> str | None:
    if timeout is None:
        timeout = FETCH_TIMEOUT
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
            "Accept-Encoding": "gzip, deflate",
            "Connection": "close",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            charset = resp.headers.get_content_charset() or "utf-8"
            text = raw.decode(charset, errors="replace")
            if text.startswith("\ufeff"):
                text = text[1:]
            return text
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError):
        return None


def _fetch(url: str) -> str | None:
    last: str | None = None
    for attempt in range(FETCH_RETRIES):
        if attempt > 0:
            print(f"[update_special]   retry {attempt + 1}/{FETCH_RETRIES} ...", flush=True)
        body = _fetch_once(url)
        if body is not None:
            return body
        last = body
        if attempt + 1 < FETCH_RETRIES:
            time.sleep(FETCH_BACKOFF * (attempt + 1))
    return last


def _strip_tags(s: str) -> str:
    t = re.sub(r"(?is)<script.*?>.*?</script>", " ", s)
    t = re.sub(r"(?is)<style.*?>.*?</style>", " ", t)
    t = re.sub(r"<[^>]+>", " ", t)
    t = html_lib.unescape(t)
    return re.sub(r"\s+", " ", t).strip()


def _first_img_url(html: str) -> str | None:
    m = re.search(r'(?i)src=["\'](https?://[^"\']+)["\']', html)
    return m.group(1) if m else None


def _parse_pub_date(text: str | None) -> datetime | None:
    if not text:
        return None
    text = text.strip()
    try:
        return parsedate_to_datetime(text)
    except (TypeError, ValueError, OverflowError):
        pass
    for fmt in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%SZ"):
        try:
            dt = datetime.strptime(text.replace("Z", "+00:00") if "Z" in text else text, fmt.replace("%z", ""))
            if "Z" in text and dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt
        except ValueError:
            continue
    return None


def _item_matches(title: str, description: str) -> bool:
    blob = f"{title}\n{description}".lower()
    return any(k in blob for k in KEYWORDS)


def _parse_rss(xml_text: str, network: str, feed_url: str) -> list[dict[str, Any]]:
    root = ET.fromstring(xml_text)
    channel = root.find("channel")
    if channel is None:
        return []
    items: list[dict[str, Any]] = []
    for it in channel.findall("item"):
        title_el = it.find("title")
        link_el = it.find("link")
        desc_el = it.find("description")
        date_el = it.find("pubDate")
        title = (title_el.text or "").strip() if title_el is not None else ""
        link = (link_el.text or "").strip() if link_el is not None else ""
        description = (desc_el.text or "").strip() if desc_el is not None else ""
        pub_raw = (date_el.text or "").strip() if date_el is not None else ""
        if not _item_matches(title, description):
            continue
        caption_plain = _strip_tags(description) or _strip_tags(title)
        img = _first_img_url(description) or _first_img_url(title)
        dt = _parse_pub_date(pub_raw)
        items.append(
            {
                "network": network,
                "title": title,
                "link": link,
                "publishedRaw": pub_raw,
                "published": dt.isoformat() if dt else None,
                "publishedSort": dt.timestamp() if dt else 0.0,
                "captionText": caption_plain,
                "image": img,
                "feedUrl": feed_url,
            }
        )
    return items


def _atom_text(el: ET.Element | None) -> str:
    if el is None:
        return ""
    if el.text:
        return el.text.strip()
    return "".join(el.itertext()).strip()


def _atom_link(entry: ET.Element) -> str:
    for rel in ("alternate", "self"):
        for link in entry.findall("atom:link", ATOM_NS):
            if link.get("rel", "alternate") == rel or (rel == "alternate" and link.get("rel") is None):
                href = link.get("href")
                if href:
                    return href.strip()
    for link in entry.findall("atom:link", ATOM_NS):
        href = link.get("href")
        if href:
            return href.strip()
    return ""


def _parse_atom(xml_text: str, network: str, feed_url: str) -> list[dict[str, Any]]:
    root = ET.fromstring(xml_text)
    if not root.tag.endswith("feed") and root.tag != f"{{{ATOM_NS['a']}}}feed":
        return []
    items: list[dict[str, Any]] = []
    for entry in root.findall("atom:entry", ATOM_NS):
        title = _atom_text(entry.find("atom:title", ATOM_NS))
        link = _atom_link(entry)
        summary_el = entry.find("atom:summary", ATOM_NS)
        content_el = entry.find("atom:content", ATOM_NS)
        summary = _atom_text(summary_el) if summary_el is not None else ""
        content = _atom_text(content_el) if content_el is not None else ""
        description = content or summary
        pub_el = entry.find("atom:published", ATOM_NS) or entry.find("atom:updated", ATOM_NS)
        pub_raw = _atom_text(pub_el)
        if not _item_matches(title, description):
            continue
        caption_plain = _strip_tags(description) or _strip_tags(title)
        img = _first_img_url(description) or _first_img_url(title)
        dt = _parse_pub_date(pub_raw)
        items.append(
            {
                "network": network,
                "title": title,
                "link": link,
                "publishedRaw": pub_raw,
                "published": dt.isoformat() if dt else None,
                "publishedSort": dt.timestamp() if dt else 0.0,
                "captionText": caption_plain,
                "image": img,
                "feedUrl": feed_url,
            }
        )
    return items


def _parse_feed(body: str, network: str, feed_url: str) -> list[dict[str, Any]]:
    stripped = body.lstrip()
    if stripped.startswith("<?xml"):
        stripped = re.sub(r"^<\?xml[^>]*\?>", "", stripped, count=1, flags=re.I).lstrip()
    if stripped.startswith("<rss") or stripped.startswith("<rdf:RDF") or "<channel>" in stripped[:800]:
        return _parse_rss(body, network, feed_url)
    if "http://www.w3.org/2005/Atom" in body[:1200] or stripped.startswith("<feed"):
        return _parse_atom(body, network, feed_url)
    return _parse_rss(body, network, feed_url)


def _empty_payload(errors: list[str]) -> dict[str, Any]:
    return {
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "source": "rsshub-rss",
        "found": False,
        "post": None,
        "posts": [],
        "errors": errors[:30],
    }


def _build_post_payload(best: dict[str, Any]) -> dict[str, Any]:
    return {
        "network": str(best.get("network") or ""),
        "title": str(best.get("title") or ""),
        "link": str(best.get("link") or ""),
        "published": best.get("published"),
        "captionText": str(best.get("captionText") or ""),
        "image": best.get("image"),
    }


def _today_local() -> datetime:
    try:
        from zoneinfo import ZoneInfo

        return datetime.now(ZoneInfo(LOCAL_TZ))
    except Exception:
        return datetime.now(timezone.utc)


def _is_same_local_day(iso_pub: str | None, today: datetime) -> bool:
    if not iso_pub:
        return False
    try:
        raw = str(iso_pub).replace("Z", "+00:00")
        dt = datetime.fromisoformat(raw)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        try:
            from zoneinfo import ZoneInfo

            local = dt.astimezone(ZoneInfo(LOCAL_TZ))
        except Exception:
            local = dt.astimezone(timezone.utc)
        return local.date() == today.date()
    except (TypeError, ValueError):
        return False


def _atomic_write_json(path: str, data: dict[str, Any]) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, path)


def main() -> int:
    errors: list[str] = []
    collected: list[dict[str, Any]] = []

    print(
        "[update_special] Starting (RSS can be slow; each URL waits up to "
        f"{FETCH_TIMEOUT}s x {FETCH_RETRIES} tries)",
        flush=True,
    )

    for network, url in _feed_urls():
        print(f"[update_special] {network}: fetching ...", flush=True)
        print(f"  {url}", flush=True)
        body = _fetch(url)
        if body is None:
            print("[update_special]   no usable response", flush=True)
            errors.append(f"fetch_failed:{url}")
            continue
        print(f"[update_special]   received {len(body)} bytes", flush=True)
        try:
            items = _parse_feed(body, network, url)
        except ET.ParseError:
            print("[update_special]   XML parse error", flush=True)
            errors.append(f"parse_error:{url}")
            continue
        print(f"[update_special]   matched {len(items)} item(s) with keyword", flush=True)
        collected.extend(items)

    fb_urls = _read_facebook_share_urls()
    if fb_urls:
        print(f"[update_special] facebook-og: {len(fb_urls)} URL(s) from {_FB_URLS_FILE} / env", flush=True)
    for post_url in fb_urls:
        if not re.search(r"(?i)facebook\.com", post_url):
            print(f"[update_special] skip (not facebook.com): {post_url}", flush=True)
            continue
        og_item = _og_item_from_facebook_url(post_url)
        if og_item:
            collected.append(og_item)
        else:
            errors.append(f"facebook_og_failed:{post_url}")

    dedup: dict[str, dict[str, Any]] = {}
    for it in collected:
        key = it.get("link") or f'{it.get("network")}:{it.get("title")}'
        prev = dedup.get(key)
        if prev is None or it["publishedSort"] > prev["publishedSort"]:
            dedup[key] = it
    unique = list(dedup.values())

    unique.sort(key=lambda it: it.get("publishedSort") or 0.0, reverse=True)

    today = _today_local()
    todays = [it for it in unique if _is_same_local_day(it.get("published"), today)]
    display = todays if todays else unique[:1]

    dest = os.path.join(os.path.dirname(__file__), "..", "special.json")
    out = _empty_payload(errors)
    if display:
        out["found"] = True
        out["posts"] = [_build_post_payload(it) for it in display]
        out["post"] = out["posts"][0]
    has_og = any(str(it.get("feedUrl", "")).startswith("facebook-og:") for it in unique)
    has_rss = any(not str(it.get("feedUrl", "")).startswith("facebook-og:") for it in unique)
    if has_og and has_rss:
        out["source"] = "rsshub-rss+facebook-og"
    elif has_og:
        out["source"] = "facebook-og"
    else:
        out["source"] = "rsshub-rss"

    try:
        _atomic_write_json(dest, out)
    except OSError as e:
        print(json.dumps({"error": str(e), "path": dest}, indent=2), flush=True)
        return 1

    print(f"[update_special] Wrote {dest}", flush=True)
    print(json.dumps({"wrote": dest, "found": out["found"], "errorCount": len(errors)}, indent=2), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
