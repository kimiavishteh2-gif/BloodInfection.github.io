# BloodInfection.github.io

**Sepsis Watch Board** — a static web page for watching and checking the research sepsis score from
[Blood-infection](https://github.com/amirrezavishteh/Blood-infection).

Live page: https://kimiavishteh2-gif.github.io/BloodInfection.github.io/

> **Not for patient care.** This is a retrospective research simulator built on the open
> PhysioNet/CinC Challenge 2019 data. The score estimates the challenge benchmark label; it is not a
> validated diagnostic or a clinical probability.

## What is on the page

| Tab | Content |
|---|---|
| **Monitor** | 24 ICU stays from hospital B (never used for training) replayed hour by hour: score per bed, alert-policy state, alert log with simulated acknowledgement, score trajectory, strongest drivers (TreeSHAP), vital signs and labs. Retrospective labels and the onset proxy are hidden until you turn them on. |
| **Performance** | The promoted model at hospital A and B, calibration, the alert-budget trade-off, all runs with 95% intervals, feature families, top features and their missingness shift, and subgroup AUROC. |
| **About** | Method, limits and citation. |

The page is plain HTML, CSS and JavaScript with no build step and no server. It reads two files:

- `data/patients.json` — the sampled stays with precomputed hourly scores, policy states and drivers
- `data/results.json` — evaluation summaries from the research run artifacts

## Refresh the data

The JSON files are generated from a trained run in the research repo:

```bash
cd ../Blood-infection
PYTHONPATH=src .venv/Scripts/python ../BloodInfection.github.io/tools/export_data.py
# options: --run <run-id>  --septic 10  --other 14  --seed 2019
```

Then commit and push the updated `data/` folder.

## Run locally

```bash
python -m http.server 8000
# open http://localhost:8000
```

Opening `index.html` directly from disk does not work, because browsers block reading the data files.

## Data and citation

PhysioNet Challenge 2019 v1.0.0, CC BY 4.0. Please cite:

- Reyna MA, et al. Early Prediction of Sepsis From Clinical Data: the PhysioNet/Computing in Cardiology Challenge 2019. *Crit Care Med* 2020;48(2):210–217.
- Goldberger A, et al. PhysioBank, PhysioToolkit, and PhysioNet. *Circulation* 2000;101(23):e215–e220.
