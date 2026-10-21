# Reusable creative components

Arya stores saved titles, compositions, effects, transitions and motion in `project.library`. Every item contains declarative native project data. Applying an item creates editable clips, layers, node graphs and keyframes. Saving or removing an item leaves its original objects and previously placed copies intact.

The browser's Titles, Transitions and Effects sections list saved items beside their built-in presets. The Library tab also lists compositions and motion. The native editor's Library button opens the same project library with a category picker. Entries show their native type and contents. They do not claim a rendered preview.

## Save and use a component

Select a title, a clip with effects or an incoming transition, or a layer with keyframes. Choose Save to library, select the component type, and enter its name. Open a composition to save its whole layer hierarchy. Selecting a composition clip also preserves that clip's placement settings and motion. Save a selected or open composition as a Transition composition to reuse its authored layers across a cut.

Place a saved title or composition at the playhead on an unlocked video track. Select a compatible clip to apply an effect, transition or motion item. Effects append to the target's existing effects and insert copied nodes before its output. Motion scales keyframe times to the target duration and preserves off-clip boundary keys used by trimmed layers. It refuses to replace an already animated property or expression. A transition needs a preceding visual clip whose end meets the target's start. It refuses to replace an existing incoming transition.

A saved transition composition creates an editable overlay centered on the selected cut. Half its source duration must fit in each adjacent clip. The overlay uses a free unlocked video track above the target, or creates one when none is free. Its native layers, keyframes and dependencies remain editable. The original adjacent clips keep their settings.

Rename changes only the saved item's label and description. Remove deletes only that saved item. Save, apply, rename and remove use the existing atomic project operations and undo history.

Forms capture their source or saved item and project version when they open. They refuse stale submissions after project data changes. The browser offers Refresh source selection while keeping typed input. Mutations send the captured `expectedVersion` through the existing operations route.

## Dependencies and copies

Saved compositions include their nested composition closure and the metadata for the project media they reference. Applying a saved component restores forgotten media records when needed. It does not create, download or copy a source file. Copy the project folder with its media files when moving the project.

Every application allocates new clip, composition, mask, node and link IDs. It rewrites parent, matte, composition and parsed layer-expression references to the new objects. Figma source notes, editable geometry, text boxes and fonts retain their source values. A standalone title with an external parent, matte, transition or layer-expression dependency must be saved through its composition.

The library rejects unsafe paths, executable values, unknown component fields, missing dependencies, duplicate object IDs, graph or composition cycles, malformed keyframes and incompatible targets before committing an edit. A project can save up to 256 items, with a 2 MB limit per item.

## Agent operations

Agents use the existing `POST /api/ops` route. `GET /api/outline` lists library IDs, their native contents and the operation reference. Create the design with normal project operations, inspect it with the existing frame tool, then save it in the same batch or a later batch.

```json
{
  "ops": [
    {
      "op": "library_save",
      "category": "title",
      "name": "Intro heading",
      "description": "Editable heading with its entrance keyframes",
      "source": { "clip": "c12" }
    }
  ],
  "summary": "Save the selected heading to Titles"
}
```

Use current IDs from the open project. `library_apply` takes `item`, plus `track`, `start` and optional `comp` for title or composition placement, or `id` for a target clip. For a transition composition, `id` identifies the clip after the cut and optional `track` must name a free unlocked video track above it. The core computes the overlay start. `library_rename` takes `item`, `name` and optional `description`. `library_remove` takes `item`.

`library_register` accepts a declared item with `name`, `category`, optional `id` and `description`, and `body`. A placement body has either a native title or composition `clip`, or a root `composition` ID, plus its `comps` dependency map and `assets` metadata. A custom transition uses a composition placement body. Target bodies use `settings`. An effect has `effects`, optional `nodes`, `grade` and node `anim` with a positive source `dur`. Motion has `anim`, `dur` and source `kind`. A built-in transition has `transitionIn` with `type` and `dur`. Declared asset metadata must match media already imported into the project. No operation evaluates JavaScript supplied by an item.

## Ask AI to animate imported layers

Open an imported Figma composition and select its layers. Ask AI accepts the user's motion intent with the exact native clip and composition IDs and the Figma node IDs present in source notes. Suggestions depend on the selected text, paths and existing animation. The assistant uses normal editable project operations. The import and animation workflow does not write to the original Figma file.

The browser attaches the request to the existing assistant reference channel. The native action opens an intent sheet and sends the request through the configured assistant. Existing Motion controls inspect and edit the resulting keyframes.
