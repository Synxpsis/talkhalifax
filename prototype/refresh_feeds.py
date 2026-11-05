"""Fetch live Halifax feeds and write one JSON document per section into ./feeds/.

Sources (all public, no keys):
  weather  Environment and Climate Change Canada city page API (Halifax, ns-19)
  tides    Fisheries and Oceans Canada IWLS predictions (Halifax station 00490)
  news     halifax.ca news RSS: City Hall, Cogswell District, Budget
  alerts   ECCC warnings, halifax.ca road closures + Windsor Street Exchange RSS,
           winter parking ban RSS, Halifax Transit service disruptions page
  events   Halifax Public Libraries events (BiblioCommons gateway API)

Run:  python refresh_feeds.py
Each output file is the body of a document in the artifact database (collection "feeds").
"""
import html
import json
import re
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

OUT = Path(__file__).resolve().parent / "feeds"
UA = {"User-Agent": "Mozilla/5.0 (TalkHalifax prototype)"}
NOW = datetime.now(timezone.utc)
HFX = "https://www.halifax.ca"


def get(url, timeout=30):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", errors="replace")


def iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def halifax_offset(dt_utc):
    """Atlantic time: UTC-3 from 2nd Sunday in March 06:00Z to 1st Sunday in November 05:00Z, else UTC-4."""
    y = dt_utc.year
    mar = datetime(y, 3, 8, tzinfo=timezone.utc)
    start = mar + timedelta(days=(6 - mar.weekday()) % 7, hours=6)
    nov = datetime(y, 11, 1, tzinfo=timezone.utc)
    end = nov + timedelta(days=(6 - nov.weekday()) % 7, hours=5)
    return timedelta(hours=-3) if start <= dt_utc < end else timedelta(hours=-4)


def local_now():
    return (NOW + halifax_offset(NOW)).replace(tzinfo=None)


def text(s, limit=None):
    s = html.unescape(re.sub(r"<[^>]+>", " ", html.unescape(s or "")))
    s = re.sub(r"\s+", " ", s).strip()
    if limit and len(s) > limit:
        s = s[: limit - 1].rsplit(" ", 1)[0] + "…"
    return s


def rss(path):
    xml = get(HFX + path)
    items = []
    for it in re.findall(r"<item>(.*?)</item>", xml, re.S):
        def tag(k):
            m = re.search(r"<%s>(.*?)</%s>" % (k, k), it, re.S)
            return m.group(1) if m else ""
        try:
            when = parsedate_to_datetime(tag("pubDate"))
        except (TypeError, ValueError):
            continue
        items.append({"title": text(tag("title")), "summary": text(tag("description"), 240),
                      "url": text(tag("link")), "published": iso(when), "_dt": when})
    return items


def en(v):
    return v.get("en") if isinstance(v, dict) else v


# ---------- weather + tides ----------
def weather():
    d = json.loads(get("https://api.weather.gc.ca/collections/citypageweather-realtime/items?f=json&identifier=ns-19"))
    p = d["features"][0]["properties"]
    c = p.get("currentConditions") or {}
    wind = c.get("wind") or {}
    current = {
        "observed": en((c.get("timestamp") or {})),
        "condition": en(c.get("condition")) or "",
        "tempC": en((c.get("temperature") or {}).get("value")),
        "windKmh": en((wind.get("speed") or {}).get("value")),
        "gustKmh": en((wind.get("gust") or {}).get("value")),
        "windDir": en((wind.get("direction") or {}).get("value")),
        "humidity": en((c.get("relativeHumidity") or {}).get("value")),
    }
    forecasts = [{"period": en(f["period"]["textForecastName"]), "summary": en(f.get("textSummary"))}
                 for f in (p.get("forecastGroup") or {}).get("forecasts", [])[:4]]
    rs = p.get("riseSet") or {}
    warnings = []
    for w in p.get("warnings") or []:
        events = w.get("events") if isinstance(w, dict) and "events" in w else [w]
        for e in events or []:
            title = en(e.get("description")) or en(e.get("type")) or "Weather alert"
            warnings.append({"title": text(str(title)), "priority": en(e.get("priority")) or "",
                             "type": en(e.get("type")) or "", "url": en(e.get("url")) or en(p.get("url"))})
    tides = []
    try:
        frm, to = iso(NOW - timedelta(hours=3)), iso(NOW + timedelta(hours=30))
        pts = json.loads(get("https://api-iwls.dfo-mpo.gc.ca/api/v1/stations/5cebf1df3d0f4a073c4bbcbb/data"
                             "?time-series-code=wlp-hilo&from=%s&to=%s" % (frm, to)))
        for i, t in enumerate(pts):
            nb = [pts[j]["value"] for j in (i - 1, i + 1) if 0 <= j < len(pts)]
            tides.append({"at": t["eventDate"], "m": round(t["value"], 2),
                          "kind": "high" if all(t["value"] > v for v in nb) else "low"})
    except Exception as e:  # tides are a nice-to-have
        print("tides failed:", e, file=sys.stderr)
    return {
        "updatedAt": iso(NOW), "issued": p.get("lastUpdated"),
        "source": "Environment and Climate Change Canada; Fisheries and Oceans Canada (tides)",
        "url": en(p.get("url")), "current": current, "forecasts": forecasts,
        "sunrise": en(rs.get("sunrise")), "sunset": en(rs.get("sunset")),
        "warnings": warnings, "tides": tides,
    }


# ---------- news ----------
def news():
    feeds = [("/news/category/rss-feed?category=17", "City Hall"),
             ("/news/category/rss-feed?category=1240", "Cogswell District"),
             ("/news/category/rss-feed?category=1252", "Budget")]
    seen, items = set(), []
    for path, section in feeds:
        for it in rss(path):
            if it["url"] in seen or NOW - it["_dt"] > timedelta(days=45):
                continue
            seen.add(it["url"])
            items.append({**it, "section": section})
    items.sort(key=lambda x: x["_dt"], reverse=True)
    for it in items:
        it.pop("_dt")
        # The release slug doubles as the article id in the database
        it["id"] = it["url"].rstrip("/").rsplit("/", 1)[-1][:200]
    return {"updatedAt": iso(NOW), "source": "halifax.ca news", "url": HFX + "/home/news", "items": items[:30]}


def save_release_texts(news_doc, days=21):
    """Save the English text of recent releases to feeds/releases/<id>.txt for article writing (cached)."""
    folder = OUT / "releases"
    folder.mkdir(exist_ok=True)
    saved = 0
    for it in news_doc["items"]:
        when = datetime.fromisoformat(it["published"].replace("Z", "+00:00"))
        path = folder / (it["id"] + ".txt")
        if NOW - when > timedelta(days=days) or path.exists():
            continue
        try:
            page = get(it["url"])
        except Exception as e:
            print("release failed:", it["id"], e, file=sys.stderr)
            continue
        page = re.sub(r"<(script|style|nav)[^>]*>.*?</\1>", "", page[page.find("<main"):], flags=re.S)
        body = html.unescape(re.sub(r"<[^>]+>", "\n", page)).replace(" ", " ")
        body = re.sub(r"[ \t]+", " ", re.sub(r"\n\s*\n+", "\n", body)).strip()
        # Keep the English half: the French version follows one of these markers
        cut = [k for k in (body.find("Message d’intérêt"), body.find("*****"), body.find("Explore this site"),
                           body.find("\nLa Municipalité"), body.find("\nLa municipalité")) if k > 0]
        body = body[: min(cut)] if cut else body[:6000]
        header = f"TITLE: {it['title']}\nPUBLISHED: {it['published']}\nSECTION: {it['section']}\nURL: {it['url']}\n\n"
        path.write_text(header + body.strip(), encoding="utf-8")
        saved += 1
    return saved


# ---------- alerts ----------
MONTHS = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}


def parse_day(s):
    m = re.search(r"([A-Za-z]{3})[a-z]*\.? (\d{1,2}), (\d{4})", s or "")
    if not m or m.group(1).lower() not in MONTHS:
        return None
    return datetime(int(m.group(3)), MONTHS[m.group(1).lower()], int(m.group(2)))


def transit_detours():
    page = get(HFX + "/transportation/halifax-transit/service-disruptions")
    page = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", page[page.find("<main"):], flags=re.S)
    lines = [l.strip() for l in html.unescape(re.sub(r"<[^>]+>", "\n", page)).split("\n")]
    lines = [l.replace(" ", " ") for l in lines if l.strip()]
    out, today = [], local_now().replace(hour=0, minute=0, second=0, microsecond=0)

    def after(i, label):
        for j in range(i, min(i + 14, len(lines))):
            if lines[j].rstrip(":") == label and j + 1 < len(lines):
                return lines[j + 1]
        return ""
    for i, l in enumerate(lines):
        if not re.match(r"^(Detour|Stop closure|Closure|Ferry)[^:]*:", l):
            continue
        end_s = after(i, "End Date")
        end = parse_day(end_s)
        if end and end < today:
            continue
        routes = after(i, "Route(s)")
        summary = ""
        for j in range(i + 1, min(i + 16, len(lines))):
            if len(lines[j]) > 60:
                summary = lines[j]
                break
        out.append({"cat": "Transit", "sev": "info", "title": l.replace("Detour: ", "Detour on ").strip(),
                    "summary": text(summary, 220), "area": ("Routes " + routes) if routes else "Halifax Transit",
                    "until": end_s if end_s and not end_s.startswith("N/A") else "until further notice",
                    "url": HFX + "/transportation/halifax-transit/service-disruptions"})
    return out


def last_mentioned_day(s):
    """Latest 'Oct. 29' / 'November 2' style date in a road notice, assuming the current year."""
    year = local_now().year
    days = [datetime(year, MONTHS[m.lower()[:3]], int(d))
            for m, d in re.findall(r"\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.? (\d{1,2})\b", s)
            if m.lower()[:3] in MONTHS and 1 <= int(d) <= 31]
    return max(days) if days else None


def alerts():
    items = []
    w = weather_doc
    for x in w["warnings"]:
        sev = "warning" if "warning" in (x["type"] + x["title"]).lower() else "advisory"
        items.append({"cat": "Weather", "sev": sev, "title": x["title"], "summary": "",
                      "area": "Halifax", "url": x["url"], "published": w["issued"]})
    for it in rss("/news/category/rss-feed?category=22")[:1]:
        if NOW - it.pop("_dt") < timedelta(hours=36):
            items.append({**it, "cat": "Parking ban", "sev": "advisory", "area": "All of Halifax"})
    seen = set()
    for path in ("/news/category/rss-feed?category=20", "/news/category/rss-feed?category=1258"):
        for it in rss(path):
            dt = it.pop("_dt")
            if it["url"] in seen or NOW - dt > timedelta(days=7):
                continue
            # Drop notices whose dates have all passed; keep undated ones for 3 days
            last = last_mentioned_day(it["title"] + " " + it["summary"])
            today = local_now().replace(hour=0, minute=0, second=0, microsecond=0)
            if (last and last < today) or (not last and NOW - dt > timedelta(days=3)):
                continue
            seen.add(it["url"])
            # "Traffic Delay - Portland Street" -> title "Portland Street", area "Traffic delay"
            parts = re.split(r"\s+[-–]\s+", it["title"], maxsplit=1)
            kind = parts[0].capitalize() if len(parts) == 2 else "Road notice"
            items.append({**it, "title": parts[-1], "cat": "Roads", "sev": "info", "area": kind})
    try:
        items += transit_detours()
    except Exception as e:
        print("transit failed:", e, file=sys.stderr)
    rank = {"warning": 0, "advisory": 1, "info": 2}
    items.sort(key=lambda x: (rank[x["sev"]], -(datetime.fromisoformat(x["published"].replace("Z", "+00:00")).timestamp() if x.get("published") else 0)))
    for i, it in enumerate(items):
        it["id"] = i + 1
    return {"updatedAt": iso(NOW), "source": "Environment and Climate Change Canada; halifax.ca; Halifax Transit",
            "items": items[:40]}


# ---------- events ----------
def events():
    base = "https://gateway.bibliocommons.com/v2/libraries/halifax/events?limit=100&page=%d"
    first = json.loads(get(base % 1))
    pages = [first] + [json.loads(get(base % n)) for n in range(2, first["events"]["pagination"]["pages"] + 1)]
    start = local_now()
    horizon = start + timedelta(days=14)
    out = {}
    for d in pages:
        ent = d["entities"]
        locs, types = ent.get("locations", {}), ent.get("eventTypes", {})
        for eid in d["events"]["items"]:
            e = ent["events"][eid]
            df = e["definition"]
            if e.get("isCancelled") or df.get("isCancelled"):
                continue
            try:
                s = datetime.fromisoformat(df["start"])
            except (KeyError, ValueError):
                continue
            if not (start - timedelta(hours=1) <= s <= horizon):
                continue
            loc = locs.get(df.get("branchLocationId") or "", {}).get("name", "")
            out[eid] = {"title": text(df.get("title")), "start": df["start"], "end": df.get("end"),
                        "venue": loc.replace(" Public Library", " Library"),
                        "types": [types[t]["name"].strip() for t in df.get("typeIds", []) if t in types][:2],
                        "summary": text(df.get("description"), 180),
                        "url": "https://halifax.bibliocommons.com/v2/events/" + eid}
    items = sorted(out.values(), key=lambda x: x["start"])[:120]
    return {"updatedAt": iso(NOW), "source": "Halifax Public Libraries",
            "url": "https://halifax.bibliocommons.com/v2/events", "items": items}


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    ok = True
    weather_doc = weather()
    docs = {"weather": weather_doc}
    for name, fn in (("news", news), ("alerts", alerts), ("events", events)):
        try:
            docs[name] = fn()
        except Exception as e:
            ok = False
            print(f"{name} failed: {e}", file=sys.stderr)
    for name, body in docs.items():
        (OUT / f"{name}.json").write_text(json.dumps(body, ensure_ascii=False, indent=1), encoding="utf-8")
        n = len(body.get("items", body.get("forecasts", [])))
        print(f"{name:8} {n:4} items  {len(json.dumps(body)) // 1024:4} KiB")
    if "news" in docs:
        print(f"releases {save_release_texts(docs['news']):4} new texts saved to feeds/releases/")
    sys.exit(0 if ok else 1)
