# ElecKoi v0.2.4 host patch

The plugin is removable; the host patch adds the small ElecKoi-side contracts required to call its service, save product state through the official host and show native child Session events in the shared trajectory.

## Exact source baseline

```text
ElecKoi: 088c2c25135fbcc1890df4d0941987d5e87e9f8f
DSH:     0.2.0-rc.2
```

Apply the patch from an untouched checkout of that ElecKoi commit:

```sh
git rev-parse HEAD
git apply --check host-patch/eleckoi-v0.2.4.patch
git apply host-patch/eleckoi-v0.2.4.patch
```

Then install and build ElecKoi using its own development instructions. Do not apply this cumulative patch twice or to another upstream revision. The plugin bundle and its source cannot substitute for this host adaptation.

The diff contains ElecKoi-derived work under its applicable AGPL license. The full plugin archive does not contain the ElecKoi application or its database.
