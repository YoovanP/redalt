import { FormEvent, useEffect, useId, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { fetchMixedSearchSuggestions, type MixedSearchSuggestion } from '../lib/redditApi';

type SubredditSwitcherProps = {
  initialSubreddit: string;
  wide?: boolean;
};

function isRedditHost(hostname: string): boolean {
  return hostname === 'reddit.com' || hostname.endsWith('.reddit.com');
}

function parseRedditTarget(input: string): string | null {
  const trimmed = input.trim();

  if (!trimmed) {
    return null;
  }

  const maybeUrl = /^(?:https?:\/\/)?(?:www\.|old\.|m\.)?reddit\.com\//i.test(trimmed);
  const maybePath = trimmed.startsWith('/');

  let path = '';
  let search = '';

  if (maybeUrl) {
    const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

    try {
      const url = new URL(withProtocol);

      if (!isRedditHost(url.hostname.toLowerCase())) {
        return null;
      }

      path = url.pathname;
      search = url.search;
    } catch {
      return null;
    }
  } else if (maybePath) {
    path = trimmed;
  } else {
    return null;
  }

  const parts = path
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length < 2) {
    return null;
  }

  const section = parts[0].toLowerCase();

  if (section === 'r') {
    const subreddit = parts[1];

    if (!subreddit) {
      return null;
    }

    if (parts[2]?.toLowerCase() === 'comments' && parts[3]) {
      return `/r/${subreddit}/comments/${parts[3]}`;
    }

    return `/r/${subreddit}${search}`;
  }

  if ((section === 'u' || section === 'user') && parts[1]) {
    return `/u/${parts[1]}`;
  }

  return null;
}

function sanitizeSubreddit(input: string): string {
  const cleaned = input
    .trim()
    .replace(/^\/?r\//i, '')
    .replace(/^\/+|\/+$/g, '')
    .split('/')[0]
    ?.replace(/[^A-Za-z0-9_]/g, '');
  return cleaned || 'mildlyinfuriating';
}

function isExplicitSubredditInput(input: string): boolean {
  const trimmed = input.trim();

  if (!trimmed) {
    return false;
  }

  return /^(?:\/?r\/|r\/)/i.test(trimmed);
}

export function SubredditSwitcher({ initialSubreddit, wide = false }: SubredditSwitcherProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const subredditQuerySuffix = location.pathname.startsWith('/r/') ? location.search : '';
  const [value, setValue] = useState(initialSubreddit);
  const [suggestions, setSuggestions] = useState<MixedSearchSuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(-1);
  const suggestionsId = useId();

  useEffect(() => {
    if (!isFocused) {
      setValue(initialSubreddit);
    }
  }, [initialSubreddit, isFocused]);

  const normalizedValue = useMemo(
    () => {
      if (parseRedditTarget(value)) {
        return '';
      }

      return value.trim().replace(/^\/?r\//i, '').toLowerCase();
    },
    [value],
  );

  useEffect(() => {
    let ignore = false;

    if (!isFocused || normalizedValue.length < 2) {
      setSuggestions([]);
      setShowSuggestions(false);
      setActiveSuggestionIndex(-1);
      return;
    }

    const handle = window.setTimeout(async () => {
      const nextSuggestions = await fetchMixedSearchSuggestions(value);

      if (ignore) {
        return;
      }

      setSuggestions(nextSuggestions);
      setActiveSuggestionIndex(-1);

      const canShow = nextSuggestions.length > 0;
      setShowSuggestions(canShow);
    }, 220);

    return () => {
      ignore = true;
      window.clearTimeout(handle);
    };
  }, [value, normalizedValue, isFocused]);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const keyword = value.trim();
    const directTarget = parseRedditTarget(value);

    if (directTarget) {
      setShowSuggestions(false);
      navigate(directTarget);
      return;
    }

    if (!keyword) {
      return;
    }

    if (!isExplicitSubredditInput(keyword)) {
      setShowSuggestions(false);
      navigate(`/search?q=${encodeURIComponent(keyword)}`);
      return;
    }

    const subreddit = sanitizeSubreddit(value);
    setValue(subreddit);
    setShowSuggestions(false);
    navigate(`/r/${subreddit}${subredditQuerySuffix}`);
  };

  const onPickSuggestion = (suggestion: MixedSearchSuggestion) => {
    setValue(suggestion.label);
    setShowSuggestions(false);
    if (suggestion.kind === 'subreddit') {
      const subreddit = suggestion.label.replace(/^r\//i, '');
      navigate(`/r/${subreddit}${subredditQuerySuffix}`);
      return;
    }

    navigate(suggestion.route);
  };

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setShowSuggestions(false);
      setActiveSuggestionIndex(-1);
      return;
    }

    if (!showSuggestions || suggestions.length === 0) {
      return;
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      setActiveSuggestionIndex((current) => {
        if (current < 0) {
          return delta > 0 ? 0 : suggestions.length - 1;
        }

        return (current + delta + suggestions.length) % suggestions.length;
      });
      return;
    }

    if (event.key === 'Enter' && activeSuggestionIndex >= 0) {
      const suggestion = suggestions[activeSuggestionIndex];

      if (suggestion) {
        event.preventDefault();
        onPickSuggestion(suggestion);
      }
    }
  };

  return (
    <form className={`subreddit-form${wide ? ' subreddit-form-wide' : ''}`} onSubmit={onSubmit}>
      <div className="subreddit-input-wrap">
        <svg className="search-input-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          value={value}
          onChange={(event) => {
            const nextValue = event.target.value;
            setValue(nextValue);
            setSuggestions([]);
            setActiveSuggestionIndex(-1);
            setShowSuggestions(false);
          }}
          onFocus={() => {
            setIsFocused(true);
            setShowSuggestions(suggestions.length > 0 && normalizedValue.length >= 2);
          }}
          onKeyDown={onInputKeyDown}
          onBlur={() =>
            window.setTimeout(() => {
              setIsFocused(false);
              setShowSuggestions(false);
            }, 120)
          }
          placeholder="Search posts, subreddits, users..."
          aria-label="Search Reddit content"
          aria-autocomplete="list"
          aria-expanded={showSuggestions}
          aria-controls={showSuggestions ? suggestionsId : undefined}
          aria-activedescendant={
            showSuggestions && activeSuggestionIndex >= 0
              ? `${suggestionsId}-${activeSuggestionIndex}`
              : undefined
          }
          autoComplete="off"
        />
        {value.length > 0 && (
          <button
            type="button"
            className="search-input-clear"
            aria-label="Clear search query"
            onClick={() => {
              setValue('');
              setSuggestions([]);
              setShowSuggestions(false);
            }}
          >
            ×
          </button>
        )}

        {showSuggestions && (
          <ul id={suggestionsId} className="subreddit-suggestions" role="listbox" aria-label="Search suggestions">
            {suggestions.map((suggestion, index) => (
              <li key={`${suggestion.kind}:${suggestion.route}`} role="presentation">
                <button
                  id={`${suggestionsId}-${index}`}
                  type="button"
                  role="option"
                  aria-selected={activeSuggestionIndex === index}
                  tabIndex={-1}
                  onMouseEnter={() => setActiveSuggestionIndex(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onPickSuggestion(suggestion)}
                >
                  <span className={`subreddit-suggestion-type suggestion-${suggestion.kind}`}>
                    {suggestion.kind}
                  </span>
                  <span className="subreddit-suggestion-main">{suggestion.label}</span>
                  {suggestion.subtitle && (
                    <span className="subreddit-suggestion-subtitle">{suggestion.subtitle}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <button type="submit" className="search-submit-button">Go</button>
      <button type="submit" className="search-submit-button-mobile" aria-label="Search">
        Search
      </button>
    </form>
  );
}
