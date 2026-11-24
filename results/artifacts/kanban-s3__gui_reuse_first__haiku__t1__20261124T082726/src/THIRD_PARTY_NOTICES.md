# Third-party notices

No third-party source code was copied into this project.

Browser searches (GitHub topic and repository search) were run for existing
kanban implementations. Candidates inspected and not reused:

- Ansh0330/Modern-Kanban-Board: vanilla JS drag-and-drop board. The repository
  shows no license, so its code was not copied. It persists data in
  localStorage and has no REST API, so it does not match the spec.
- wekan/wekan, and similar Meteor/React kanban apps: too large and framework-based.
- Other drag-and-drop component libraries: front-end only, no server to adapt.

All server, routing, auth, and UI code in ./src was written for this project.
