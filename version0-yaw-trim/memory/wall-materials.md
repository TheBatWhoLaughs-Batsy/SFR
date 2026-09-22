# Wall materials — measured permittivity and loss

**Purpose** — `sarEpsilonR` and the wall thickness are the two most consequential SAR settings
(a wrong permittivity was measured at **11 dB** of lost target contrast, more than every other
parameter combined). These are the measured values for the test walls.

---

## Method

Antennas touching the wall, capture a background, then place a **metal plate flat against the far
face**. The plate is the only thing that changed, so the differenced profile holds one
unambiguous echo and its apparent range is `√εr · thickness`.

Better than reading a back-face echo, which on a low-permittivity block is weak and easily
confused with whatever is behind it.

## Measured

| wall | thickness | plate at | εr (raw) | εr (slant-corrected) | expected dry |
|---|---|---|---|---|---|
| cement | 15 cm | 33 cm | 4.84 | **4.68** | 4.5-6.5 |
| red clay brick | 21.5 cm | 51 cm | 5.63 | **5.55** | 4.5-6 |
| AAC block | 15 cm | 36 cm | 5.76 | **5.60** | **1.8-2.5 — WET** |

**Set `sarEpsilonR` per material.** The SAR panel defaults to the gw2 cement bench.

## Slant-path correction

TX and RX are separated, so the path is two slant legs: `R = n·z + (d/2)² / (2·z·n)`. Only a few
percent, but **measure the baseline rather than assuming it** — put the plate at a known distance
in *air* and read what the UI reports. That one capture calibrates the baseline and any residual
range-offset error at once. Better still, measure two thicknesses and take the **slope**, which
needs no offset at all.

## Attenuation

One-way `α[dB/m] = 8.686 · π · f · √εr · tan δ / c`; two-way loss through thickness `t` is
`2·α·t`. At 3.5 GHz: cement 0.74 dB/cm two-way → **11 dB** through 15 cm; red brick 0.60 dB/cm →
**13 dB** through 21.5 cm; dry AAC 0.18 dB/cm → **2.8 dB** through 15 cm.

So a **dry** AAC block should return the plate about 8 dB *stronger* than the cement one under
identical gains — an independent wet/dry test needing no new capture.

Consequence for "why not sweep 5-10 GHz": moving the centre from 3.5 to 7.5 GHz costs ~13 dB
through 15 cm of cement, not ~26 — which is inside the transmit headroom. The answer is still no,
but on the **clutter** argument (clutter scales with power, and texture scattering grows with
frequency), not on the loss arithmetic.

---

## The AAC block is wet, and it is a calibration opportunity

60 × 15 × 20 cm, **12.1 kg = 672 kg/m³**. Solving the mixing model at εr 5.6 gives **538 kg/m³ of
dry skeleton plus 134 kg/m³ of water** — an ordinary grade-550 block at **~25% moisture by
weight**, which is what a block fresh from the autoclave or stored damp looks like.

**Density alone could not have shown this** — it says nothing about what fills the pores. Two
things did:

1. **Offsets cannot explain the reading.** The cement and AAC blocks are both 15 cm thick in the
   same geometry, so range offset, cable delay and the slant term all cancel in the difference:
   `√εr(AAC) − √εr(cement) = (36−33)/15 = 0.20`, whatever those offsets are.
2. **The plate echo is much weaker through the AAC than through the cement** — the wet branch of
   the 20 dB fork above.

The block is still easy to lift while the cement one is barely liftable. **Lightness is density;
permittivity follows what fills the pores.** At 13.4% water by volume the water contributes 1.18
of the 2.37 total √εr, *more* than the 22% solid skeleton's 0.53 — so wet AAC and dense cement
read nearly the same εr by opposite routes.

### Drying curve

`√εr = 1.312 + 7.85·θ` (θ = water by volume), mass = `(538 + 1000·θ)·0.018` kg.

| water (vol) | weight | εr | plate at, 15 cm |
|---|---|---|---|
| 13.4% (as measured) | 12.1 kg | 5.6 | 35.4 cm |
| 10% | 11.5 kg | 4.4 | 31.5 cm |
| 5% | 10.6 kg | 2.9 | 25.6 cm |
| 2.7% (= 5% by weight) | 10.2 kg | 2.3 | 22.9 cm |
| 0% (oven dry) | 9.7 kg | 1.7 | 19.7 cm |

**~4-6% by weight (~10.2 kg) is AAC's indoor equilibrium**, so that — not the oven-dry 9.7 kg —
is the realistic target, with ~2.4 kg of water to lose.

Log weight and apparent range as it dries: that is the εr-versus-moisture calibration the seepage
detector wants, and **the two must move together or the model is wrong.**

**Do not use this block as the clean low-loss test bed until it is dry.** Wet, it is the lossiest
of the three walls, not the least.

## Note on the estimator

**Dry AAC at εr ≈ 2 will never be the permittivity estimator's highlighted pick** — its plausible
window starts at 3. It appears only as a chip. Do not widen that window: εr ≈ 2.4 is where this
bench's rig echo poses as a back wall.
