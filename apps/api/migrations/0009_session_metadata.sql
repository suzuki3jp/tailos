ALTER TABLE sessions ADD COLUMN title TEXT NOT NULL DEFAULT '新しい会話';
--> statement-breakpoint
ALTER TABLE sessions ADD COLUMN title_generated INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE sessions ADD COLUMN trigger_metadata TEXT;
--> statement-breakpoint
ALTER TABLE sessions ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE sessions SET
  title = coalesce((SELECT p.title FROM planning_snapshots p JOIN runs r ON r.id = p.run_id
    WHERE r.session_id = sessions.id ORDER BY p.created_at, p.run_id LIMIT 1), title),
  updated_at = max(created_at,
    coalesce((SELECT max(m.created_at) FROM session_messages m WHERE m.session_id = sessions.id), 0),
    coalesce((SELECT max(r.created_at) FROM runs r WHERE r.session_id = sessions.id), 0),
    coalesce((SELECT max(r.finished_at) FROM runs r WHERE r.session_id = sessions.id), 0));
--> statement-breakpoint
UPDATE sessions SET trigger_metadata = (
  SELECT json_object('kind', 'github.issue',
    'repository', json_extract(r.execution_context, '$.repository.repository'),
    'number', json_extract(r.execution_context, '$.repository.issueNumber'),
    'url', 'https://github.com/' || json_extract(r.execution_context, '$.repository.repository') ||
      '/issues/' || json_extract(r.execution_context, '$.repository.issueNumber'))
  FROM runs r WHERE r.session_id = sessions.id
    AND json_valid(r.execution_context) AND json_valid(sessions.target)
    AND json_extract(sessions.target, '$.kind') = 'github.issue'
    AND json_extract(r.execution_context, '$.repository.repositoryId') = json_extract(sessions.target, '$.repositoryId')
    AND json_extract(r.execution_context, '$.repository.issueNumber') = json_extract(sessions.target, '$.issueNumber')
    AND json_type(r.execution_context, '$.repository.repository') = 'text'
  ORDER BY r.created_at, r.id LIMIT 1
) WHERE json_valid(target);
--> statement-breakpoint
CREATE INDEX session_owner_updated ON sessions(owner_id, updated_at DESC, id DESC);
--> statement-breakpoint
CREATE TRIGGER session_created_activity AFTER INSERT ON sessions BEGIN
  UPDATE sessions SET updated_at = max(NEW.created_at, NEW.updated_at) WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER session_message_activity AFTER INSERT ON session_messages BEGIN
  UPDATE sessions SET updated_at = max(updated_at, NEW.created_at) WHERE id = NEW.session_id;
END;
--> statement-breakpoint
CREATE TRIGGER session_run_activity AFTER INSERT ON runs BEGIN
  UPDATE sessions SET updated_at = max(updated_at, NEW.created_at) WHERE id = NEW.session_id;
END;
--> statement-breakpoint
CREATE TRIGGER session_run_transition_activity AFTER UPDATE OF status ON runs
WHEN NEW.status IN ('succeeded', 'failed') AND NEW.status != OLD.status AND NEW.finished_at IS NOT NULL BEGIN
  -- Starting activity is written atomically by claim(runId, now). Both paths
  -- use Worker timestamps rather than mixing the Worker and D1 clocks.
  UPDATE sessions SET updated_at = max(updated_at, NEW.finished_at) WHERE id = NEW.session_id;
END;
