"""
Plausibilitäts-Check für way_gradients.py-Outputs.

Liest eine Ergebnis-CSV ein und gibt Verteilungen, Auffälligkeiten und
Beispiel-Kandidaten zur Sichtprüfung in QGIS aus.

Aufruf:
    uv run python analyze_gradients.py output/baden-wuerttemberg_gradients.csv

Unterstützt sowohl alte CSVs (eine Gradient-Spalte) als auch das neue Format
mit gradient_abs_avg_pct + gradient_smooth_pct + gradient_endpoint_pct
+ is_implausible_grad.

Wichtigste Auffälligkeitsklassen:
  - "Noise-Inflation": gradient_abs_avg_pct >> gradient_smooth_pct → die
    Glättung hat hochfrequente DEM-Wackler weggebügelt, die abs_avg
    fälschlich als Steigung gezählt hatte.
  - "Welligkeit erkannt": gradient_smooth_pct >> gradient_endpoint_pct →
    die Strecke hat echte Auf-Ab-Bewegung (Hügel, Wellen), die der
    Endpunkt-Vergleich nicht sieht.
  - "Kurz & steil": Way < short_length m, Gradient > short_steep_grad %.
    Mit min-length-Gate sollten das nur noch Sonderfälle sein.
  - "Implausibel steil": is_implausible_grad == 1 (Pipeline-Flag) oder
    gradient_smooth_pct > steep_threshold.
  - "DEM-Lücke": n_samples == 0.
"""

from __future__ import annotations

import argparse
import csv
from pathlib import Path

import numpy as np


# Pflichtspalten — die fehlen niemals
REQUIRED = ["osm_id", "length_m", "gradient_abs_avg_pct",
            "elevation_gain_m", "elevation_loss_m",
            "n_samples", "is_bridge_or_tunnel"]
# Neue Spalten — werden mit NaN gefüllt wenn nicht vorhanden
OPTIONAL = ["gradient_smooth_pct", "gradient_endpoint_pct",
            "is_implausible_grad", "is_bridge_adjacent"]
# LADOT-Bin-Spalten (signed): Anteil des Ways in % pro Steigungsklasse
LADOT_BINS = [
    ("slope_1", "2-4%"),
    ("slope_2", "4-6%"),
    ("slope_3", "6-10%"),
    ("slope_4", "10%+"),
]
LADOT_FIELDS = [f"{name}_{d}_pct" for name, _ in LADOT_BINS for d in ("fwd", "bwd")]


def load_csv(path: Path) -> tuple[dict[str, np.ndarray], set[str]]:
    """Liest CSV; gibt (cols, present_optional) zurück."""
    cols: dict[str, list] = {c: [] for c in REQUIRED + OPTIONAL + LADOT_FIELDS}
    with path.open() as fh:
        reader = csv.DictReader(fh)
        present = set(reader.fieldnames or [])
        present_optional = (set(OPTIONAL) | set(LADOT_FIELDS)) & present
        for row in reader:
            cols["osm_id"].append(int(row["osm_id"]))
            for k in ("length_m", "gradient_abs_avg_pct",
                      "elevation_gain_m", "elevation_loss_m"):
                v = row[k]
                cols[k].append(float(v) if v not in ("", None) else np.nan)
            cols["n_samples"].append(int(row["n_samples"]))
            cols["is_bridge_or_tunnel"].append(int(row["is_bridge_or_tunnel"]))
            for k in ("gradient_smooth_pct", "gradient_endpoint_pct"):
                v = row.get(k, "")
                cols[k].append(float(v) if v not in ("", None) else np.nan)
            v = row.get("is_implausible_grad", "")
            cols["is_implausible_grad"].append(int(v) if v not in ("", None) else 0)
            v = row.get("is_bridge_adjacent", "")
            cols["is_bridge_adjacent"].append(int(v) if v not in ("", None) else 0)
            for k in LADOT_FIELDS:
                v = row.get(k, "")
                cols[k].append(float(v) if v not in ("", None) else np.nan)
    return {k: np.array(v) for k, v in cols.items()}, present_optional


def quantiles_line(values: np.ndarray, qs=(0.5, 0.75, 0.9, 0.95, 0.99, 0.999, 1.0)) -> str:
    valid = values[np.isfinite(values)]
    if valid.size == 0:
        return "  (keine gültigen Werte)"
    parts = []
    for q in qs:
        v = float(np.quantile(valid, q))
        parts.append(f"p{int(q * 1000) / 10:g}={v:.2f}")
    return "  " + "   ".join(parts)


def hist_ascii(values: np.ndarray, edges: list[float], width: int = 40, unit: str = "") -> None:
    valid = values[np.isfinite(values)]
    counts, _ = np.histogram(valid, bins=edges)
    max_count = counts.max() if counts.size else 1
    total = counts.sum()
    for c, lo, hi in zip(counts, edges[:-1], edges[1:]):
        bar = "█" * int(width * c / max_count) if max_count else ""
        pct = 100 * c / total if total else 0
        print(f"  [{lo:>6.1f} – {hi:>6.1f}{unit}] {c:>9,d}  {pct:>5.1f}%  {bar}")


def print_examples(label: str, mask: np.ndarray, d: dict[str, np.ndarray],
                    sort_key: np.ndarray, top: int, has_new: bool, descending: bool = True) -> None:
    mask = mask & np.isfinite(sort_key)
    idx = np.where(mask)[0]
    if idx.size == 0:
        print(f"  ({label}: keine Treffer)")
        return
    order = np.argsort(sort_key[idx])
    if descending:
        order = order[::-1]
    idx = idx[order][:top]
    print(f"  {label}:")
    if has_new:
        print(f"    {'osm_id':>12}  {'len[m]':>8}  {'abs%':>6}  {'smo%':>6}  {'end%':>6}  {'gain':>6}  {'loss':>6}  {'n':>4}  {'fl':>2}")
        for i in idx:
            print(
                f"    {int(d['osm_id'][i]):>12}  "
                f"{d['length_m'][i]:>8.1f}  "
                f"{d['gradient_abs_avg_pct'][i]:>6.2f}  "
                f"{d['gradient_smooth_pct'][i]:>6.2f}  "
                f"{d['gradient_endpoint_pct'][i]:>6.2f}  "
                f"{d['elevation_gain_m'][i]:>6.1f}  "
                f"{d['elevation_loss_m'][i]:>6.1f}  "
                f"{int(d['n_samples'][i]):>4}  "
                f"{int(d['is_implausible_grad'][i]):>2}"
            )
    else:
        print(f"    {'osm_id':>12}  {'len[m]':>8}  {'grad%':>7}  {'gain':>6}  {'loss':>6}  {'n':>4}")
        for i in idx:
            print(
                f"    {int(d['osm_id'][i]):>12}  "
                f"{d['length_m'][i]:>8.1f}  "
                f"{d['gradient_abs_avg_pct'][i]:>7.2f}  "
                f"{d['elevation_gain_m'][i]:>6.1f}  "
                f"{d['elevation_loss_m'][i]:>6.1f}  "
                f"{int(d['n_samples'][i]):>4}"
            )


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("csv", type=Path, help="Pfad zur Ergebnis-CSV")
    ap.add_argument("--top", type=int, default=10, help="Anzahl Beispiele pro Kategorie")
    ap.add_argument("--steep-threshold", type=float, default=30.0,
                    help="Gradient-Grenze 'implausibel steil' in %% (default: 30)")
    ap.add_argument("--short-length", type=float, default=15.0,
                    help="Längengrenze 'sehr kurz' in m (default: 15)")
    ap.add_argument("--short-steep-grad", type=float, default=10.0,
                    help="Gradient-Grenze für 'kurz UND steil' (default: 10%%)")
    ap.add_argument("--noise-min-length", type=float, default=50.0,
                    help="Rauschboden-Check nur ab Länge (default: 50m)")
    args = ap.parse_args()

    if not args.csv.exists():
        raise SystemExit(f"CSV nicht gefunden: {args.csv}")

    print(f"\n=== {args.csv.name} ===")
    d, present_opt = load_csv(args.csv)
    has_new = {"gradient_smooth_pct", "gradient_endpoint_pct"}.issubset(present_opt)
    has_flag = "is_implausible_grad" in present_opt

    if has_new:
        print("CSV-Format: NEU (3 Gradient-Spalten + Flag)")
    else:
        print("CSV-Format: ALT (nur gradient_abs_avg_pct)")

    n_total = len(d["osm_id"])
    print(f"Ways gesamt:                  {n_total:>10,d}")

    is_bt = d["is_bridge_or_tunnel"].astype(bool)
    print(f"  davon Bridge/Tunnel/Covered:{int(is_bt.sum()):>10,d}  ({100 * is_bt.mean():.1f}%)")
    if "is_bridge_adjacent" in present_opt:
        is_ba = d["is_bridge_adjacent"].astype(bool)
        print(f"  davon Bridge-Adjacent:      {int(is_ba.sum()):>10,d}  ({100 * is_ba.mean():.1f}%)")

    # Ab hier nur "normale" Ways
    keep = ~is_bt
    sub = {k: v[keep] for k, v in d.items()}
    length = sub["length_m"]
    grad_abs = sub["gradient_abs_avg_pct"]
    grad_smooth = sub["gradient_smooth_pct"]
    grad_endpoint = sub["gradient_endpoint_pct"]
    gain = sub["elevation_gain_m"]
    loss = sub["elevation_loss_m"]
    n_samples = sub["n_samples"]
    impl_flag = sub["is_implausible_grad"]
    n_normal = int(keep.sum())
    print(f"Normale Ways analysiert:      {n_normal:>10,d}")

    no_data = n_samples == 0
    print(f"  davon ohne DEM-Sample:      {int(no_data.sum()):>10,d}")
    print(f"  davon abs_avg leer (NaN):   {int((~np.isfinite(grad_abs)).sum()):>10,d}")
    if has_new:
        print(f"  davon smooth leer (NaN):    {int((~np.isfinite(grad_smooth)).sum()):>10,d}")
        print(f"  davon endpoint leer (NaN):  {int((~np.isfinite(grad_endpoint)).sum()):>10,d}")
    if has_flag:
        print(f"  is_implausible_grad == 1:   {int(impl_flag.sum()):>10,d}  ({100 * impl_flag.mean():.2f}%)")

    # ----- Verteilungen ---------------------------------------------------
    print("\n--- Längen-Verteilung [m] ---")
    print(quantiles_line(length))
    hist_ascii(
        length,
        edges=[0, 5, 10, 15, 25, 50, 100, 250, 500, 1000, 5000, np.inf],
        unit="m",
    )

    grad_edges = [0, 1, 2, 3, 5, 8, 12, 20, 30, 50, 100, np.inf]
    print("\n--- Gradient gradient_abs_avg_pct [%] ---")
    print(quantiles_line(grad_abs))
    hist_ascii(grad_abs, edges=grad_edges, unit="%")
    if has_new:
        print("\n--- Gradient gradient_smooth_pct [%] ---")
        print(quantiles_line(grad_smooth))
        hist_ascii(grad_smooth, edges=grad_edges, unit="%")
        print("\n--- Gradient gradient_endpoint_pct [%] ---")
        print(quantiles_line(grad_endpoint))
        hist_ascii(grad_endpoint, edges=grad_edges, unit="%")

    # ----- Plausibilitäts-Flags ------------------------------------------
    print("\n--- Plausibilitäts-Checks ---")
    # Bei has_new ist die Empfehlung: smooth ist der "ehrlichste" Wert,
    # also nutzen wir den fürs Flagging. Falls nicht da, fallback auf abs_avg.
    primary = grad_smooth if has_new else grad_abs
    steep = np.isfinite(primary) & (primary > args.steep_threshold)
    very_steep = np.isfinite(primary) & (primary > 50)
    short = length < args.short_length
    short_steep = short & np.isfinite(primary) & (primary > args.short_steep_grad)

    def share(mask: np.ndarray) -> str:
        return f"{int(mask.sum()):>10,d}  ({100 * mask.sum() / max(n_normal, 1):.2f}%)"

    metric_label = "smooth" if has_new else "abs_avg"
    print(f"  {metric_label} > {args.steep_threshold:g}%:           {share(steep)}")
    print(f"  {metric_label} > 50%:           {share(very_steep)}")
    print(f"  Kurz (<{args.short_length:g}m):                {share(short)}")
    print(f"  Kurz & steil ({metric_label} > {args.short_steep_grad:g}%): {share(short_steep)}")

    if has_new:
        # Noise-Inflation: abs deutlich > smooth.
        # Absolute Differenz (Prozentpunkte), nicht relative — sonst wird's
        # bei kleinen smooth-Werten beliebig groß.
        noise_diff = grad_abs - grad_smooth
        big_noise = np.isfinite(noise_diff) & (noise_diff > 2.0)
        print(f"  Noise-Inflation (abs-smooth > 2pp): {share(big_noise)}")

        # Welligkeits-Erkennung: smooth deutlich > endpoint.
        # (Die Strecke geht hoch und wieder runter, Netto-Drift gering, aber
        # auf der Strecke gibt es echte Höhenarbeit.)
        wave_diff = grad_smooth - grad_endpoint
        big_wave = np.isfinite(wave_diff) & (wave_diff > 2.0) & (length >= args.noise_min_length)
        print(f"  Welligkeit (smooth-endpoint > 2pp): {share(big_wave)}")

    # ----- Beispiele -----------------------------------------------------
    print(f"\n--- Top {args.top} Beispiele pro Kategorie ---\n")

    print_examples(
        f"Steilste Ways nach {metric_label}",
        np.ones(n_normal, dtype=bool),
        sub, primary, args.top, has_new,
    )
    print()
    print_examples(
        f"Kurz (<{args.short_length:g}m) UND steil (>{args.short_steep_grad:g}%), sortiert nach {metric_label}",
        short_steep,
        sub, primary, args.top, has_new,
    )

    if has_new:
        print()
        print_examples(
            "Noise-Inflation (abs - smooth größte Differenz)",
            (grad_abs - grad_smooth) > 0,
            sub, grad_abs - grad_smooth, args.top, has_new,
        )
        print()
        print_examples(
            "Welligkeit erkannt (smooth - endpoint größte Differenz, len ≥ 50m)",
            (grad_smooth - grad_endpoint > 0) & (length >= args.noise_min_length),
            sub, grad_smooth - grad_endpoint, args.top, has_new,
        )

    # ----- Rauschboden-Schätzung ------------------------------------------
    # Auf "flachen" Wegen (kleiner Netto-Drift, ausreichend lang) zeigt
    # gradient_abs_avg_pct den DEM-Noise-Floor — gradient_smooth_pct sollte
    # deutlich kleiner sein, gradient_endpoint_pct nochmal kleiner.
    print("\n--- Geschätzter Rausch-Boden ---")
    net = gain - loss
    valid_flat = (
        np.isfinite(grad_abs) & np.isfinite(net)
        & (length >= args.noise_min_length)
    )
    if valid_flat.sum() > 100:
        with np.errstate(invalid="ignore", divide="ignore"):
            net_per_len = np.abs(net) / np.where(length > 0, length, np.nan) * 100
        flat = valid_flat & (net_per_len < 0.5)
        if flat.sum() > 50:
            print(f"  Ways mit |Netto-Steigung| < 0.5% und Länge ≥ {args.noise_min_length:g}m: {int(flat.sum())}")
            print(f"  gradient_abs_avg_pct dort (sollte rauschend > 0 sein):")
            print(quantiles_line(grad_abs[flat]))
            if has_new:
                print(f"  gradient_smooth_pct dort (sollte deutlich kleiner sein):")
                print(quantiles_line(grad_smooth[flat]))
                print(f"  gradient_endpoint_pct dort (sollte nahe 0 sein):")
                print(quantiles_line(grad_endpoint[flat]))
        else:
            print("  Zu wenige flache Ways für Rauschboden-Schätzung.")
    else:
        print("  Zu wenige Ways für Rauschboden-Schätzung.")

    # ----- Steigungs-Klassen-Übersicht -----------------------------------
    has_ladot = all(f in present_opt for f in LADOT_FIELDS)
    if has_ladot:
        print("\n--- Steigungs-Klassen-Anteile (signed, disjunkte Bins) ---")
        print(f"  Berechnet auf {keep.sum():,d} normalen Ways "
              f"(ohne Bridges/Tunnel).")

        # Gesamt-Netzwerk-km pro Bin: aggregierter Anteil × Way-Länge.
        total_km = float(np.nansum(length)) / 1000
        print(f"  Netzwerk-Gesamtlänge (normale Ways): {total_km:,.1f} km")
        print()
        print(f"  {'Bin':<8} {'Label':<8} "
              f"{'fwd km':>10} {'fwd %':>7}  "
              f"{'bwd km':>10} {'bwd %':>7}  "
              f"{'Ways≠0 fwd':>10} {'Ways≠0 bwd':>10}")
        sum_fwd_km = 0.0
        sum_bwd_km = 0.0
        for name, label in LADOT_BINS:
            fwd = sub[f"{name}_fwd_pct"]
            bwd = sub[f"{name}_bwd_pct"]
            with np.errstate(invalid="ignore"):
                fwd_km = float(np.nansum(length * fwd / 100)) / 1000
                bwd_km = float(np.nansum(length * bwd / 100)) / 1000
            sum_fwd_km += fwd_km
            sum_bwd_km += bwd_km
            fwd_share = 100 * fwd_km / total_km if total_km > 0 else 0
            bwd_share = 100 * bwd_km / total_km if total_km > 0 else 0
            ways_fwd = int(np.sum(np.isfinite(fwd) & (fwd > 0)))
            ways_bwd = int(np.sum(np.isfinite(bwd) & (bwd > 0)))
            print(f"  {name:<8} {label:<8} "
                  f"{fwd_km:>10.1f} {fwd_share:>6.2f}%  "
                  f"{bwd_km:>10.1f} {bwd_share:>6.2f}%  "
                  f"{ways_fwd:>10,d} {ways_bwd:>10,d}")

        flat_km = max(total_km - sum_fwd_km - sum_bwd_km, 0)
        flat_share = 100 * flat_km / total_km if total_km > 0 else 0
        print(f"  {'(flach)':<8} {'<2%':<8} "
              f"{'':>10} {'':>7}   {'':>10} {'':>7}  "
              f"{flat_km:>9.1f} km {flat_share:>5.1f}% des Netzwerks")


if __name__ == "__main__":
    main()
