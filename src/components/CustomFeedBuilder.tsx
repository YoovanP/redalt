import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

const STORAGE_KEY = 'redalt.customFeed';

function sanitizeSubreddit(input: string): string {
  return input
    .trim()
    .replace(/^\/?r\//i, '')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase();
}

function loadSavedSubreddits(): string[] {
  try {
    const value = localStorage.getItem(STORAGE_KEY);

    if (!value) {
      return [];
    }

    const parsed = JSON.parse(value) as unknown;

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((entry) => (typeof entry === 'string' ? sanitizeSubreddit(entry) : ''))
      .filter(Boolean);
  } catch {
    return [];
  }
}

type CustomFeedBuilderProps = {
  currentSubreddit: string;
};

export function CustomFeedBuilder({ currentSubreddit }: CustomFeedBuilderProps) {
  const navigate = useNavigate();
  const [value, setValue] = useState('');
  const [savedSubreddits, setSavedSubreddits] = useState<string[]>([]);

  useEffect(() => {
    setSavedSubreddits(loadSavedSubreddits());
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedSubreddits));
  }, [savedSubreddits]);

  const combinedFeed = useMemo(() => savedSubreddits.join('+'), [savedSubreddits]);

  const addSubreddit = (subredditInput: string) => {
    const subreddit = sanitizeSubreddit(subredditInput);

    if (!subreddit) {
      return;
    }

    setSavedSubreddits((previous) => {
      if (previous.includes(subreddit)) {
        return previous;
      }

      return [...previous, subreddit];
    });
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    addSubreddit(value);
    setValue('');
  };

  const removeSubreddit = (subreddit: string) => {
    setSavedSubreddits((previous) => previous.filter((entry) => entry !== subreddit));
  };

  return (
    <section className="custom-feed">
      <form className="custom-feed-form" onSubmit={onSubmit}>
        <div className="custom-feed-input-row">
          <input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="Add subreddit"
            aria-label="Add subreddit to custom feed"
          />
          <button type="submit">Add</button>
        </div>

        <div className="custom-feed-actions">
          <button type="button" onClick={() => addSubreddit(currentSubreddit)}>
            Add current
          </button>
          <button
            type="button"
            disabled={savedSubreddits.length === 0}
            onClick={() => navigate(`/r/${combinedFeed}`)}
          >
            Open custom feed
          </button>
        </div>
      </form>

      {savedSubreddits.length > 0 && (
        <div className="custom-feed-list">
          {savedSubreddits.map((subreddit) => (
            <span key={subreddit} className="subreddit-chip">
              r/{subreddit}
              <button
                type="button"
                aria-label={`Remove ${subreddit}`}
                onClick={() => removeSubreddit(subreddit)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
