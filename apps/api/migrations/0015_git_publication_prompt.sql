-- Tailos no longer publishes at the end of a Run: the Agent pushes and opens
-- pull requests itself. Routines that kept the default prompt, which said
-- Tailos publishes, get the new default. Prompts someone wrote stay as they are.
UPDATE routines
SET config = json_set(config, '$.prompt', 'Implement the GitHub issue identified by the structured job context. Read the issue using tailos_github_get, make the required changes, and run relevant checks. Commit the changes on a new branch, push it, and open a pull request with gh whose body includes Closes #<issue number>. Summarize the result with the pull request URL.'),
  revision = revision + 1,
  updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER),
  updated_by = 'migration:git-publication'
WHERE deleted_at IS NULL
  AND json_extract(config, '$.prompt') = 'Implement the GitHub issue identified by the structured job context. Read the issue using tailos_github_get, make the required changes, run relevant checks, and summarize the result. Tailos handles publishing.';
