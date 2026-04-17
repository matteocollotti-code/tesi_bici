# GTFS Peak Monitor

Python script: `gtfs_peak_monitor.py`

## Features
- Polls a GTFS Realtime TripUpdates protobuf feed every 20 seconds (configurable).
- Runs only inside configurable peak windows (defaults: 07:00-09:30 and 17:00-19:30).
- Decodes TripUpdates and stores observations with acquisition timestamp.
- Links `trip_id`, `route_id`, and `stop_id` against GTFS static (`trips.txt`, `routes.txt`, `stops.txt`).
- Supports SQLite (default) or CSV output.
- Deduplicates repeated observations using a deterministic hash key.
- Computes end-of-period metrics:
  - average delay by route
  - average delay by trip
  - maximum delay
  - percentage of trips delayed more than 5 minutes
  - most delayed stops
- Includes logging and retry handling for download failures.

## Dependencies
```bash
pip install requests gtfs-realtime-bindings
```

## Run
```bash
python gtfs_peak_monitor.py --settings gtfs_peak_monitor.settings.json
```

Update `gtfs_peak_monitor.settings.json` with your feed URL and static GTFS zip path.
