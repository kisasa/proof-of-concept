# Activation: Intake Agent

PROJECT: <PROJECT_TITLE> (<PROJECT_ID>)

<ACTIVATION_TRIGGER>

Using the Linear connector, read:

- the project's description
- its hypothesis brief document, if one exists yet
- its `Surfaces` document, if one exists yet
- all project attachments, including any layout screenshots
- the full comment thread (structured: top-level comments vs. replies,
  authors, timestamps)
- the project's status-update history. A human may reply in a status update
  instead of a comment.

Determine your current state from the comment thread and the status updates,
and proceed per your decision flow.
