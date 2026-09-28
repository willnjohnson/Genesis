# Changelog (v0.4.9)

## Added

### Glossary & Terms

* **Auto-Detected Terms**: Terms are now detected automatically from glossary links in the Transcript and AI Summary, not added by hand.
* **Jump to a Term**: Clicking a term jumps to and highlights it in the text.
* **Split Library Search**: Search a term's mentions everywhere, or only where it's glossary-linked, each with a live result count.
* **New Search Facet, Untagged (`!#`)**: Find videos with no tags. `!#keyword` narrows further.

### Drives

* **Color Decoration**: Right-click a Drive in the tree and choose "Edit Color Decoration" to mark it with a colored chip, in a choice of 7 colors.

### Reordering

* **Drag-and-Drop**: Reorder Drive Sequences and Attachments by dragging a row to a new spot.

## Improved

### Sidebar

* **Unsaved Changes Warning**: Leaving the sidebar with an unsaved edit now asks first, instead of silently losing it.

### Venice AI

* **Post-Processing Options** (Settings » API Key » Venice): toggle stripping quote marks from quoteblocks and leading emojis from headers, paragraphs, list items and quoteblocks.

# Changelog (v0.4.8)

## Added

### Title Bar

* **Custom Title Bar**: Kinesis now draws its own slim title bar on Windows and Linux, with back and forward arrows (`Alt + Left` / `Alt + Right`), the Kinesis logo, name and version, What's New, and the minimize, maximize/restore and close buttons. Drag it to move the window, or double-click it to maximize.
* **Title Bar Navigation**: A new **Title Bar** option under Settings » Display » Navigation Orientation moves Search, Library, Glossary, Biography, the grid/compact toggle, Settings and the workspace switcher into the title bar, leaving more room for content.
  * The workspace name sits beside its switch button (when in titlebar mode) as one button. When the window gets too narrow, the name hides and only the switch button remains.
  * The name and switcher are hidden while the Workspaces screen is open.

## Improved

* **Description Preview**: Hovering over a glossary term or biography entry in Glossary/Biography shows a preview of its description, without needing to click the entry to view it.
* **Status Bar Trash**: Right-clicking the trash in the status bar allows quick manual restoration or deletion, without forcing you to open the modal. The modal is still useful if you want to view multiple soft-deleted items.
* **Right-Click Context Menu on Video Card**: Right-clicking on a video card now shows a context menu where you can choose a specific action, including "Open in YouTube" and "Copy citation".
