# RedAlt Industrial Media UI Revamp Design

**Date:** 2026-05-28

## Goal

Create a bold RedAlt UI prototype for a Reddit-like platform using an **Industrial Command Center + Liquid Nightlife** direction: dense, sharp, dark, operational, and media-forward.

## Approved Direction

Use the chosen **A + C** combination:

- Industrial dark command-center structure
- Orange signal accents
- Monospace metadata and compact controls
- Larger image/video areas from the media-forward direction
- No right rail

## Page Structure

### Top navigation

A black steel header with:

- RedAlt wordmark
- Subreddit/search field
- Saved, history, settings, and mode controls as compact command chips

### Left rail

A fixed-width command panel with:

- Quick communities
- Feed modes
- Compact status/settings blocks

### Main feed

A media-first feed with:

- Large preview area for image/video posts
- Sharp orange metadata strip
- Compact title, subreddit, author, score, and comment metadata
- Action chips for comments, share, save, Reddit source, and outbound source

### Mobile behavior

On smaller screens:

- Left rail collapses into a horizontal chip bar
- Header wraps cleanly
- Feed remains single-column and media-forward
- Cards keep the same visual identity without requiring side rails

## Visual Language

- Background: near-black steel with subtle grid/noise texture
- Primary accent: industrial orange
- Secondary accent: cyan glow used sparingly for media/search emphasis
- Typography: heavy display wordmark, monospace metadata, strong compact body text
- Surfaces: hard borders, bevel-like shadows, clipped corners, diagnostic-style labels
- Motion: small hover lifts, signal glow, subtle scan/grid atmosphere

## Scope

The next implementation should generate a standalone HTML prototype page in the `redalt` project. It should not yet replace the React app shell. The prototype will validate the visual system before applying it to `src/App.tsx`, `src/index.css`, and feed components.

## Out of Scope

- No right rail
- No backend/API changes
- No routing changes
- No permanent React refactor yet
- No feature additions beyond visual prototype content
