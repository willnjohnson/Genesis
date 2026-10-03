# Changelog (v0.5.1)

## Added

### Video Timestamps

* **Jump to a Moment**: Type a timestamp in square brackets, like `[1:23]` or `[1:02:03]`, in a Transcript or AI Summary. It shows as a clickable link, and jumps the sidebar's video to that moment. The square bracket syntax `[]` is important, to not confuse a timestamp with a ratio (2:1) or a time of day (12:00 PM).
  * With the video player hidden, clicking a timestamp opens the video on YouTube at that moment instead. Autoplay is turned off, so user would need to click the video to start it at the timestamp.
* **Timed Video Links**: A video link can start partway through: `[Talk](kinesis://video/ID?t=1:23)`. It shows its time and opens the video at that moment, or just jumps there if the video is already open.
  * Shortcut: type the timestamp straight after the link, `[Talk](kinesis://video/ID)[1:23]`, and it becomes part of the link when you save. This works anywhere you can add links: Transcripts, AI Summaries, Glossary definitions and Biographies.
  * A timestamp on its own only jumps the video in the sidebar. In Glossary definitions and Biographies, where there's no player, it stays plain text.
* **Copy Link at Time**: Hover the sidebar's video and click **Copy Link at Time** to copy a link to the video that starts where it's playing, ready to paste into any text.

### Tags

* **Essential Tags**: Every workspace now has five built-in tags for keeping track of videos: **Watch Later**, **Favorite**, **Revisit**, **Key Source** and **Follow Up**. They sit in their own **Essentials** section at the top of the Glossary's tags, each with its own icon, and can't be renamed or deleted.

### Links

* **Backlinks**: See everything that links to a video or a person. A video's new **Backlinks** tab (beside Attachments) and a person's Biography list each AI Summary, Transcript, Note, Glossary definition and Biography that links there, with the words around the link. Click a row to open it.
  * For a video, the moments other texts link to are listed too; click one to jump the video there.

* **External Link Confirmation**: Kinesis now asks before opening an external website from your content, showing the address first. This covers links in transcripts, summaries, glossary definitions and biographies, and Biography's social and website icons. Links Kinesis makes itself, like Open in YouTube, open straight away.

## Changed

### Title Bar

* **Binder Tabs**: In Title Bar navigation, Search, Library, Glossary and Biography are now tabs (instead of buttons) and appear after the workspace name, with the Kinesis logo, name and version on the left. The open tab is marked with an accent line.

### AI Summaries

* **Linked Creator**: The creator's name in a summary's "Channel Info" line now links to their Biography. New summaries get it automatically.
  * Summaries saved before this update still show the name as plain text. Update them all at once: [Link creators in older summaries](action:link-channel-info)

## Fixed

### Trash

* **Restoring a Creator's Videos**: Restoring videos from the Trash after all of a creator's videos were deleted now brings back their Biography too, in any order you restore them. Before, the videos came back without a Biography entry.

### Drives

* **Drive Tree Updates**: Changing a Drive's alias, Category Marker or Decoration Marker in Manage Drive now updates the Drive Tree right away, along with the Drive name shown in the status bar.

# Changelog (v0.5.0)

## Added

### Manage Drive

* **Manage Drive Section**:
  * Get an overview of an entire drive.
  * View all of the sequences that exist.
  * View all videos that aren't sorted into a Drive and view each Drive (similar to the existing Drive Tree).
  * Viewing an individual drive shows an overview, allows user to edit markers and alias.
* **Drive Node Actions**:
  * Add sub-drives.
  * Rename the current drive node.
  * Move/merge into another node.

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
