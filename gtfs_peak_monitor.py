#!/usr/bin/env python3
"""Monitor GTFS-Realtime TripUpdates during configurable peak windows."""

from __future__ import annotations

import csv
import dataclasses
import datetime as dt
import hashlib
import json
import logging
import sqlite3
import time
import zipfile
from collections import defaultdict
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Set, Tuple

import requests
from google.transit import gtfs_realtime_pb2


@dataclasses.dataclass(frozen=True)
class PeakWindow:
    start: dt.time
    end: dt.time


@dataclasses.dataclass(frozen=True)
class StaticIndex:
    trips_to_route: Dict[str, str]
    route_ids: Set[str]
    stop_ids: Set[str]


@dataclasses.dataclass(frozen=True)
class Observation:
    acquisition_ts: str
    feed_timestamp: Optional[int]
    entity_id: str
    trip_id: str
    route_id: str
    stop_id: str
    arrival_delay_s: Optional[int]
    departure_delay_s: Optional[int]
    schedule_relationship: str
    start_date: str
    start_time: str
    trip_exists_in_static: int
    route_exists_in_static: int
    stop_exists_in_static: int
    dedup_key: str


def load_settings(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as f:
        cfg = json.load(f)

    required = ["feed_url", "static_gtfs_zip", "output", "time_windows"]
    missing = [k for k in required if k not in cfg]
    if missing:
        raise ValueError(f"Missing settings keys: {missing}")
    return cfg


def parse_time_windows(raw: Sequence[dict]) -> List[PeakWindow]:
    windows: List[PeakWindow] = []
    for item in raw:
        start = dt.datetime.strptime(item["start"], "%H:%M").time()
        end = dt.datetime.strptime(item["end"], "%H:%M").time()
        if start >= end:
            raise ValueError(f"Window start must be before end: {item}")
        windows.append(PeakWindow(start=start, end=end))
    return windows


def build_static_index(static_zip: Path) -> StaticIndex:
    trips_to_route: Dict[str, str] = {}
    route_ids: Set[str] = set()
    stop_ids: Set[str] = set()

    with zipfile.ZipFile(static_zip, "r") as zf:
        with zf.open("routes.txt") as routes_file:
            for row in csv.DictReader((line.decode("utf-8-sig") for line in routes_file)):
                route_id = row.get("route_id")
                if route_id:
                    route_ids.add(route_id)

        with zf.open("trips.txt") as trips_file:
            for row in csv.DictReader((line.decode("utf-8-sig") for line in trips_file)):
                trip_id = row.get("trip_id")
                route_id = row.get("route_id", "")
                if trip_id:
                    trips_to_route[trip_id] = route_id
                    if route_id:
                        route_ids.add(route_id)

        with zf.open("stops.txt") as stops_file:
            for row in csv.DictReader((line.decode("utf-8-sig") for line in stops_file)):
                stop_id = row.get("stop_id")
                if stop_id:
                    stop_ids.add(stop_id)

    return StaticIndex(
        trips_to_route=trips_to_route,
        route_ids=route_ids,
        stop_ids=stop_ids,
    )


def init_sqlite(db_path: Path) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS observations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                acquisition_ts TEXT NOT NULL,
                feed_timestamp INTEGER,
                entity_id TEXT NOT NULL,
                trip_id TEXT NOT NULL,
                route_id TEXT NOT NULL,
                stop_id TEXT NOT NULL,
                arrival_delay_s INTEGER,
                departure_delay_s INTEGER,
                schedule_relationship TEXT NOT NULL,
                start_date TEXT,
                start_time TEXT,
                trip_exists_in_static INTEGER NOT NULL,
                route_exists_in_static INTEGER NOT NULL,
                stop_exists_in_static INTEGER NOT NULL,
                dedup_key TEXT NOT NULL UNIQUE
            );

            CREATE TABLE IF NOT EXISTS period_summary (
                period_label TEXT NOT NULL,
                computed_at TEXT NOT NULL,
                avg_delay_by_route_json TEXT NOT NULL,
                avg_delay_by_trip_json TEXT NOT NULL,
                maximum_delay_s INTEGER NOT NULL,
                pct_trips_delayed_gt_5m REAL NOT NULL,
                most_delayed_stops_json TEXT NOT NULL
            );
            """
        )
        conn.commit()
    finally:
        conn.close()


def existing_csv_keys(csv_path: Path) -> Set[str]:
    if not csv_path.exists():
        return set()
    keys: Set[str] = set()
    with csv_path.open("r", encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            key = row.get("dedup_key")
            if key:
                keys.add(key)
    return keys


def write_observations_sqlite(db_path: Path, rows: Sequence[Observation]) -> int:
    if not rows:
        return 0
    conn = sqlite3.connect(db_path)
    inserted = 0
    try:
        cursor = conn.cursor()
        for r in rows:
            cursor.execute(
                """
                INSERT OR IGNORE INTO observations (
                    acquisition_ts, feed_timestamp, entity_id, trip_id, route_id, stop_id,
                    arrival_delay_s, departure_delay_s, schedule_relationship, start_date,
                    start_time, trip_exists_in_static, route_exists_in_static,
                    stop_exists_in_static, dedup_key
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    r.acquisition_ts,
                    r.feed_timestamp,
                    r.entity_id,
                    r.trip_id,
                    r.route_id,
                    r.stop_id,
                    r.arrival_delay_s,
                    r.departure_delay_s,
                    r.schedule_relationship,
                    r.start_date,
                    r.start_time,
                    r.trip_exists_in_static,
                    r.route_exists_in_static,
                    r.stop_exists_in_static,
                    r.dedup_key,
                ),
            )
            inserted += cursor.rowcount
        conn.commit()
    finally:
        conn.close()
    return inserted


def write_observations_csv(csv_path: Path, rows: Sequence[Observation], cache: Set[str]) -> int:
    if not rows:
        return 0

    csv_path.parent.mkdir(parents=True, exist_ok=True)
    headers = [f.name for f in dataclasses.fields(Observation)]
    needs_header = not csv_path.exists()
    inserted = 0

    with csv_path.open("a", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=headers)
        if needs_header:
            writer.writeheader()

        for row in rows:
            if row.dedup_key in cache:
                continue
            writer.writerow(dataclasses.asdict(row))
            cache.add(row.dedup_key)
            inserted += 1
    return inserted


def compute_dedup_key(*parts: str) -> str:
    raw = "|".join(parts)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def extract_observations(
    feed: gtfs_realtime_pb2.FeedMessage,
    static_idx: StaticIndex,
    acquisition_ts: dt.datetime,
) -> List[Observation]:
    rows: List[Observation] = []
    acq_iso = acquisition_ts.isoformat(timespec="seconds")
    feed_ts = feed.header.timestamp if feed.header.timestamp else None

    for entity in feed.entity:
        if not entity.HasField("trip_update"):
            continue
        tu = entity.trip_update
        trip = tu.trip

        trip_id = trip.trip_id or ""
        route_id = trip.route_id or static_idx.trips_to_route.get(trip_id, "")
        start_date = trip.start_date or ""
        start_time = trip.start_time or ""
        schedule_rel = gtfs_realtime_pb2.TripDescriptor.ScheduleRelationship.Name(
            trip.schedule_relationship
        )

        for stu in tu.stop_time_update:
            stop_id = stu.stop_id or ""
            arr_delay = stu.arrival.delay if stu.HasField("arrival") and stu.arrival.HasField("delay") else None
            dep_delay = stu.departure.delay if stu.HasField("departure") and stu.departure.HasField("delay") else None

            dedup_key = compute_dedup_key(
                str(feed_ts),
                entity.id or "",
                trip_id,
                route_id,
                stop_id,
                str(arr_delay),
                str(dep_delay),
                start_date,
                start_time,
            )

            rows.append(
                Observation(
                    acquisition_ts=acq_iso,
                    feed_timestamp=feed_ts,
                    entity_id=entity.id or "",
                    trip_id=trip_id,
                    route_id=route_id,
                    stop_id=stop_id,
                    arrival_delay_s=arr_delay,
                    departure_delay_s=dep_delay,
                    schedule_relationship=schedule_rel,
                    start_date=start_date,
                    start_time=start_time,
                    trip_exists_in_static=int(trip_id in static_idx.trips_to_route),
                    route_exists_in_static=int(route_id in static_idx.route_ids),
                    stop_exists_in_static=int(stop_id in static_idx.stop_ids),
                    dedup_key=dedup_key,
                )
            )

    return rows


def download_feed(url: str, timeout_s: int, retries: int, backoff_s: int) -> bytes:
    last_err: Optional[Exception] = None
    for attempt in range(1, retries + 1):
        try:
            response = requests.get(url, timeout=timeout_s)
            response.raise_for_status()
            return response.content
        except Exception as exc:
            last_err = exc
            logging.warning("Feed download attempt %s/%s failed: %s", attempt, retries, exc)
            if attempt < retries:
                time.sleep(backoff_s * attempt)
    raise RuntimeError(f"Failed to download feed after {retries} attempts: {last_err}")


def parse_feed(content: bytes) -> gtfs_realtime_pb2.FeedMessage:
    msg = gtfs_realtime_pb2.FeedMessage()
    msg.ParseFromString(content)
    return msg


def now_in_window(now: dt.datetime, windows: Sequence[PeakWindow]) -> Optional[PeakWindow]:
    now_t = now.timetz().replace(tzinfo=None)
    for w in windows:
        if w.start <= now_t < w.end:
            return w
    return None


def next_window_start(now: dt.datetime, windows: Sequence[PeakWindow]) -> dt.datetime:
    today = now.date()
    candidates = [dt.datetime.combine(today, w.start, tzinfo=now.tzinfo) for w in windows]
    future_today = [c for c in candidates if c > now]
    if future_today:
        return min(future_today)
    tomorrow = today + dt.timedelta(days=1)
    return min(dt.datetime.combine(tomorrow, w.start, tzinfo=now.tzinfo) for w in windows)


def period_label(day: dt.date, window: PeakWindow) -> str:
    return f"{day.isoformat()} {window.start.strftime('%H:%M')}-{window.end.strftime('%H:%M')}"


def fetch_period_rows_sqlite(db_path: Path, label: str) -> List[sqlite3.Row]:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        cur = conn.execute(
            """
            SELECT *
            FROM observations
            WHERE acquisition_ts >= ? AND acquisition_ts < ?
            """,
            (
                label.split(" ")[0] + "T" + label.split(" ")[1].split("-")[0] + ":00",
                label.split(" ")[0] + "T" + label.split(" ")[1].split("-")[1] + ":00",
            ),
        )
        return cur.fetchall()
    finally:
        conn.close()


def summarize(rows: Iterable[sqlite3.Row | Observation]) -> dict:
    by_route: Dict[str, List[int]] = defaultdict(list)
    by_trip: Dict[str, List[int]] = defaultdict(list)
    by_stop: Dict[str, List[int]] = defaultdict(list)
    trip_max_delay: Dict[str, int] = defaultdict(int)
    all_delays: List[int] = []

    for row in rows:
        route_id = row["route_id"] if isinstance(row, sqlite3.Row) else row.route_id
        trip_id = row["trip_id"] if isinstance(row, sqlite3.Row) else row.trip_id
        stop_id = row["stop_id"] if isinstance(row, sqlite3.Row) else row.stop_id
        arr = row["arrival_delay_s"] if isinstance(row, sqlite3.Row) else row.arrival_delay_s
        dep = row["departure_delay_s"] if isinstance(row, sqlite3.Row) else row.departure_delay_s

        delay_values = [d for d in (arr, dep) if d is not None]
        if not delay_values:
            continue

        for delay in delay_values:
            by_route[route_id].append(delay)
            by_trip[trip_id].append(delay)
            by_stop[stop_id].append(delay)
            all_delays.append(delay)
            if delay > trip_max_delay[trip_id]:
                trip_max_delay[trip_id] = delay

    avg_by_route = {r: round(sum(v) / len(v), 2) for r, v in by_route.items() if v}
    avg_by_trip = {t: round(sum(v) / len(v), 2) for t, v in by_trip.items() if v}
    max_delay = max(all_delays) if all_delays else 0

    delayed_trip_count = sum(1 for d in trip_max_delay.values() if d > 300)
    pct_trips_delayed = round((delayed_trip_count / len(trip_max_delay)) * 100, 2) if trip_max_delay else 0.0

    most_delayed_stops = sorted(
        (
            {"stop_id": s, "avg_delay_s": round(sum(v) / len(v), 2), "observations": len(v)}
            for s, v in by_stop.items()
            if v
        ),
        key=lambda x: x["avg_delay_s"],
        reverse=True,
    )[:10]

    return {
        "avg_delay_by_route": avg_by_route,
        "avg_delay_by_trip": avg_by_trip,
        "maximum_delay_s": max_delay,
        "pct_trips_delayed_gt_5m": pct_trips_delayed,
        "most_delayed_stops": most_delayed_stops,
    }


def store_summary_sqlite(db_path: Path, label: str, summary: dict) -> None:
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """
            INSERT INTO period_summary (
                period_label,
                computed_at,
                avg_delay_by_route_json,
                avg_delay_by_trip_json,
                maximum_delay_s,
                pct_trips_delayed_gt_5m,
                most_delayed_stops_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                label,
                dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
                json.dumps(summary["avg_delay_by_route"], ensure_ascii=False),
                json.dumps(summary["avg_delay_by_trip"], ensure_ascii=False),
                summary["maximum_delay_s"],
                summary["pct_trips_delayed_gt_5m"],
                json.dumps(summary["most_delayed_stops"], ensure_ascii=False),
            ),
        )
        conn.commit()
    finally:
        conn.close()


def store_summary_csv(path: Path, label: str, summary: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    headers = [
        "period_label",
        "computed_at",
        "avg_delay_by_route_json",
        "avg_delay_by_trip_json",
        "maximum_delay_s",
        "pct_trips_delayed_gt_5m",
        "most_delayed_stops_json",
    ]
    needs_header = not path.exists()
    with path.open("a", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=headers)
        if needs_header:
            writer.writeheader()
        writer.writerow(
            {
                "period_label": label,
                "computed_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
                "avg_delay_by_route_json": json.dumps(summary["avg_delay_by_route"], ensure_ascii=False),
                "avg_delay_by_trip_json": json.dumps(summary["avg_delay_by_trip"], ensure_ascii=False),
                "maximum_delay_s": summary["maximum_delay_s"],
                "pct_trips_delayed_gt_5m": summary["pct_trips_delayed_gt_5m"],
                "most_delayed_stops_json": json.dumps(summary["most_delayed_stops"], ensure_ascii=False),
            }
        )


def run(settings_path: Path) -> None:
    cfg = load_settings(settings_path)

    timezone = dt.timezone(dt.timedelta(hours=cfg.get("timezone_utc_offset_hours", 0)))
    windows = parse_time_windows(cfg["time_windows"])
    static_idx = build_static_index(Path(cfg["static_gtfs_zip"]))

    out_cfg = cfg["output"]
    out_mode = out_cfg.get("mode", "sqlite").lower()
    poll_seconds = int(cfg.get("poll_seconds", 20))
    timeout_seconds = int(cfg.get("request_timeout_seconds", 20))
    retries = int(cfg.get("retry_attempts", 3))
    backoff = int(cfg.get("retry_backoff_seconds", 2))

    csv_dedup_cache: Set[str] = set()

    if out_mode == "sqlite":
        obs_path = Path(out_cfg.get("sqlite_path", "output/gtfs_observations.sqlite"))
        init_sqlite(obs_path)
    elif out_mode == "csv":
        obs_path = Path(out_cfg.get("observations_csv_path", "output/observations.csv"))
        csv_dedup_cache = existing_csv_keys(obs_path)
    else:
        raise ValueError("output.mode must be 'sqlite' or 'csv'")

    summary_csv_path = Path(out_cfg.get("summary_csv_path", "output/period_summary.csv"))

    last_active_label: Optional[str] = None
    in_memory_period_rows: List[Observation] = []

    logging.info("GTFS peak monitor started. Poll interval: %ss", poll_seconds)

    while True:
        now = dt.datetime.now(timezone)
        active_window = now_in_window(now, windows)

        if not active_window:
            if last_active_label and in_memory_period_rows and out_mode == "csv":
                summary = summarize(in_memory_period_rows)
                store_summary_csv(summary_csv_path, last_active_label, summary)
                logging.info("Peak period ended: %s | summary=%s", last_active_label, summary)
                in_memory_period_rows.clear()
            elif last_active_label and out_mode == "sqlite":
                rows = fetch_period_rows_sqlite(obs_path, last_active_label)
                summary = summarize(rows)
                store_summary_sqlite(obs_path, last_active_label, summary)
                logging.info("Peak period ended: %s | summary=%s", last_active_label, summary)

            last_active_label = None
            nxt = next_window_start(now, windows)
            sleep_for = max(1, int((nxt - now).total_seconds()))
            logging.info("Outside peak windows. Sleeping until %s (%ss)", nxt.isoformat(timespec="seconds"), sleep_for)
            time.sleep(min(sleep_for, 300))
            continue

        current_label = period_label(now.date(), active_window)
        if last_active_label is None:
            last_active_label = current_label
            logging.info("Entered peak period: %s", current_label)

        try:
            raw = download_feed(
                cfg["feed_url"],
                timeout_s=timeout_seconds,
                retries=retries,
                backoff_s=backoff,
            )
            feed = parse_feed(raw)
            acq = dt.datetime.now(timezone)
            rows = extract_observations(feed, static_idx, acq)

            if out_mode == "sqlite":
                inserted = write_observations_sqlite(obs_path, rows)
            else:
                inserted = write_observations_csv(obs_path, rows, csv_dedup_cache)
                in_memory_period_rows.extend(rows)

            logging.info(
                "Polled feed. entities=%s observations=%s inserted=%s",
                len(feed.entity),
                len(rows),
                inserted,
            )
        except Exception:
            logging.exception("Polling cycle failed")

        time.sleep(poll_seconds)


def configure_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s | %(levelname)s | %(message)s",
    )


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="GTFS Realtime peak-hours monitor")
    parser.add_argument(
        "--settings",
        type=Path,
        default=Path("gtfs_peak_monitor.settings.json"),
        help="Path to JSON settings file",
    )
    args = parser.parse_args()

    cfg = load_settings(args.settings)
    configure_logging(cfg.get("log_level", "INFO"))
    run(args.settings)


if __name__ == "__main__":
    main()
