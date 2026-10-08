"""Export the static data behind the GitHub Pages monitor.

Run from the Blood-infection research repo with its virtualenv, e.g.

    cd ../Blood-infection
    .venv/Scripts/python ../BloodInfection.github.io/tools/export_data.py

It writes two files next to this script's parent:

* data/patients.json - a small, seeded sample of hospital B (external test)
  records, replayed hour by hour with the promoted model's calibrated score,
  data-quality status, alert-policy state, top contributions, vitals, labs and
  the retrospective label (hidden by default on the page).
* data/results.json - evaluation summaries for every run plus the promoted
  run's calibration, alert budgets, subgroups and feature-family shares.

Scores come from the run's own predictions.parquet (the frozen evaluation),
so the page shows exactly what was evaluated; nothing is retrained.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

from sepsis.alerts.policy import AlertPolicy, initial_state, step
from sepsis.data.schema import LABS, VITALS
from sepsis.data.store import Store
from sepsis.labels.targets import onset_from_challenge_labels
from sepsis.models.bundle import load_bundle

SITE = Path(__file__).resolve().parents[1]
SHOW_LABS = ["Lactate", "WBC", "Creatinine", "Platelets", "Bilirubin_total", "BUN", "pH", "FiO2", "Glucose"]
MAX_HOURS = 96


def r(x, nd=4):
    return None if x is None or not np.isfinite(float(x)) else round(float(x), nd)


def pick_stays(pred: pd.DataFrame, enc: pd.DataFrame, n_septic: int, n_other: int, seed: int) -> list[str]:
    """Seeded sample: septic (not left-censored) and non-septic stays of 24-96 h."""
    e = enc[(enc["hospital_key"] == "B") & enc["n_hours"].between(24, MAX_HOURS)]
    rng = np.random.default_rng(seed)
    septic = e[e["ever_positive"] & ~e["first_row_positive"]]["stay_id"].to_numpy()
    other = e[~e["ever_positive"]]["stay_id"].to_numpy()
    # Over-sample non-septic stays whose peak score is high, so the board shows false alerts too.
    peak = pred.groupby("stay_id")["score"].max()
    high = [s for s in other if peak.get(s, 0) >= 0.09]
    low = [s for s in other if peak.get(s, 0) < 0.09]
    k_high = min(len(high), n_other // 3)
    chosen = (list(rng.choice(septic, n_septic, replace=False))
              + list(rng.choice(high, k_high, replace=False))
              + list(rng.choice(low, n_other - k_high, replace=False)))
    rng.shuffle(chosen)
    return chosen


def export_patients(run_dir: Path, store: Store, args) -> dict:
    b = load_bundle(run_dir)
    policy = AlertPolicy.from_dict(b.policy)
    pred = pd.read_parquet(run_dir / "eval" / "b_external" / "predictions.parquet")
    ids = pick_stays(pred, store.encounters, args.septic, args.other, args.seed)

    feat_path = store.root / "features" / f"{b.feature_schema_version}.parquet"
    feats = pd.read_parquet(feat_path, filters=[("stay_id", "in", ids)])
    hourly = store.hourly[store.hourly["stay_id"].isin(ids)]
    enc = store.encounters.set_index("stay_id")

    patients = []
    for bed, sid in enumerate(ids, start=1):
        p = pred[pred["stay_id"] == sid].sort_values("hour_index")
        h = hourly[hourly["stay_id"] == sid].sort_values("hour_index").set_index("hour_index")
        f = feats[feats["stay_id"] == sid].sort_values("hour_index")
        X = f[b.feature_names].to_numpy(dtype=np.float32)
        contrib = b.model.contributions(X)[:, :-1]
        labels = p["label"].to_numpy()
        info = onset_from_challenge_labels(labels)

        state, hours = initial_state(), []
        for i, row in enumerate(p.itertuples()):
            score = None if row.status != "scored" else float(row.score)
            state, emitted = step(policy, state, int(row.hour_index), score, row.status)
            hr = h.loc[row.hour_index]
            top = np.argsort(-np.abs(contrib[i]))[:6]
            hours.append({
                "h": int(row.hour_index),
                "s": r(score),
                "st": state["state"],
                "a": bool(emitted),
                "y": int(row.label),
                "v": {v: r(hr[v], 1) for v in VITALS if not pd.isna(hr[v])},
                "l": {v: r(hr[v], 2) for v in SHOW_LABS if not pd.isna(hr[v])},
                "c": [[b.feature_names[j], r(contrib[i, j], 3), r(X[i, j], 2)] for j in top]
                if score is not None else [],
            })
        e = enc.loc[sid]
        patients.append({
            "bed": f"B-{bed:02d}",
            "record": e["record"],
            "age": r(h["Age"].iloc[0], 0),
            "gender_code": None if pd.isna(h["Gender"].iloc[0]) else int(h["Gender"].iloc[0]),
            "n_hours": len(hours),
            "septic": bool(info.septic),
            "onset_hour": None if info.onset_hour is None else int(info.onset_hour),
            "hours": hours,
        })
    return {
        "run": b.meta.get("run_id", run_dir.name),
        "model_kind": b.meta["model_kind"],
        "feature_schema_version": b.feature_schema_version,
        "policy": b.policy,
        "split": "b_external",
        "seed": args.seed,
        "labs_shown": SHOW_LABS,
        "patients": patients,
    }


def summarise(ev: dict) -> dict:
    hourly, al, bm = ev["hourly"], ev["alerts"], ev["benchmark"]
    return {
        "records": ev["records"],
        "auroc": hourly["auroc"], "auroc_ci": hourly.get("auroc_ci"),
        "auprc": hourly["auprc"], "auprc_ci": hourly.get("auprc_ci"),
        "brier": hourly["brier"], "prevalence": hourly["positive_hour_prevalence"],
        "utility": bm["utility"], "utility_ci": bm.get("utility_ci"),
        "early_sensitivity": al["early_sensitivity"], "alert_precision": al["alert_precision"],
        "alerts_per_100pd": al["alerts_per_100_patient_days"],
        "false_alerts_nonseptic_per_100pd": al["false_alerts_nonseptic_per_100_patient_days"],
        "lead_time_median_h": al["lead_time_median_h"], "lead_time_iqr_h": al["lead_time_iqr_h"],
        "evaluation_number": ev.get("evaluation_number_for_split"),
    }


def export_results(art: Path, promoted: str) -> dict:
    exp = json.loads((art / "reports" / "experiments.json").read_text())
    runs = []
    for run in exp["runs"]:
        runs.append({
            "run": run["run_id"], "model_kind": run["model_kind"], "feature_set": run["feature_set"],
            "validation_auprc": run.get("validation_auprc"),
            "policy": run.get("alert_policy"),
            "evals": {k: summarise(v) for k, v in run["evaluations"].items()},
        })
    rd = art / "runs" / promoted
    full = {s: json.loads((rd / "eval" / s / "metrics.json").read_text()) for s in ("a_test", "b_external")}
    ps = json.loads((rd / "policy_search.json").read_text())
    ex = json.loads((rd / "explain.json").read_text())
    return {
        "promoted": promoted,
        "promotion": json.loads((art / "promotion.json").read_text()),
        "runs": runs,
        "reliability": {s: full[s]["hourly"]["reliability"] for s in full},
        "subgroups": {s: full[s]["subgroups"] for s in full},
        "baselines": {s: full[s]["baselines"] for s in full},
        "coverage": {s: full[s]["coverage"] for s in full},
        "official": {s: full[s]["official"] for s in full},
        "alerts": {s: full[s]["alerts"] for s in full},
        "budgets": ps["by_budget"],
        "explain": {"family_share": ex["family_share"], "top_features": ex["top_features"][:12],
                    "note": ex.get("note")},
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--artifacts", default="artifacts")
    ap.add_argument("--run", default=None, help="defaults to the promoted run")
    ap.add_argument("--septic", type=int, default=10)
    ap.add_argument("--other", type=int, default=14)
    ap.add_argument("--seed", type=int, default=2019)
    args = ap.parse_args()

    art = Path(args.artifacts).resolve()
    promoted = args.run or json.loads((art / "promotion.json").read_text())["selected"]
    store = Store.for_dataset("physionet2019")
    out = SITE / "data"
    out.mkdir(exist_ok=True)
    (out / "results.json").write_text(json.dumps(export_results(art, promoted), default=float,
                                                 separators=(",", ":"), allow_nan=False))
    (out / "patients.json").write_text(json.dumps(export_patients(art / "runs" / promoted, store, args),
                                                  default=float, separators=(",", ":"), allow_nan=False))
    for f in ("results.json", "patients.json"):
        print(f, f"{(out / f).stat().st_size / 1024:.0f} KiB")


if __name__ == "__main__":
    main()
