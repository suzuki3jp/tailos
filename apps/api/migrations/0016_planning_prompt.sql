-- Planning no longer runs in a read-only mode whose instructions the Runner
-- added: every Turn runs with the same permissions, and a plan Routine plans
-- because its prompt asks it to. Routines that kept the default plan prompt
-- get the new default, which carries those instructions. Prompts someone
-- wrote stay as they are.
UPDATE routines
SET config = json_set(config, '$.prompt', 'Plan the GitHub issue identified by the structured job context, answering the new message from a permitted user. Read the issue using tailos_github_get and investigate the repository. Do not implement or publish changes. Reply with a concrete plan with assumptions, affected files, implementation steps and validation methods. Include questions if needed, then end this turn without waiting for answers; questions alone are a complete reply. Post your reply on the issue as a comment with gh issue comment, without mentioning anyone with @, and give the same reply in your answer.'),
  revision = revision + 1,
  updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER),
  updated_by = 'migration:planning-prompt'
WHERE deleted_at IS NULL
  AND json_extract(config, '$.prompt') = 'Plan the GitHub issue identified by the structured job context, answering the new message from a permitted user. Read the issue using tailos_github_get. Do not implement or publish changes. Post your reply on the issue as a comment with gh issue comment, without mentioning anyone with @, and give the same reply in your answer.';
