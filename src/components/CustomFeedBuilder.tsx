import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CUSTOM_FEED_UPDATE_EVENT,
  notifyCustomFeedUpdate,
  readCustomFeedSubreddits,
  sanitizeSubreddit,
  writeCustomFeedSubreddits,
} from '../lib/customFeed';

type CustomFeedBuilderProps = {
  currentSubreddit: string;
};

export function CustomFeedBuilder({ currentSubreddit }: CustomFeedBuilderProps) {
  const navigate = useNavigate();
  const [value, setValue] = useState('');
  const [savedSubreddits, setSavedSubreddits] = useState<string[]>([]);

  useEffect(() => {
    setSavedSubreddits(readCustomFeedSubreddits());

    const onUpdate = () => setSavedSubreddits(readCustomFeedSubreddits());
    window.addEventListener(CUSTOM_FEED_UPDATE_EVENT, onUpdate);
    return () => window.removeEventListener(CUSTOM_FEED_UPDATE_EVENT, onUpdate);
  }, []);

  const combinedFeed = useMemo(() => savedSubreddits.join('+'), [savedSubreddits]);

  const saveSubreddits = (nextSubreddits: string[]) => {
    writeCustomFeedSubreddits(nextSubreddits);
    setSavedSubreddits(readCustomFeedSubreddits());
    notifyCustomFeedUpdate();
  };

  const addSubreddit = (subredditInput: string) => {
    const subreddit = sanitizeSubreddit(subredditInput);

    if (!subreddit) {
      return;
    }

    if (!savedSubreddits.includes(subreddit)) {
      saveSubreddits([...savedSubreddits, subreddit]);
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    addSubreddit(value);
    setValue('');
  };

  const removeSubreddit = (subreddit: string) => {
    saveSubreddits(savedSubreddits.filter((entry) => entry !== subreddit));
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
