--
-- 0000_baseline.sql -- the schema every later migration assumes.
--
-- Captured with `pg_dump --schema-only --no-owner --no-privileges` from the
-- production database on 2026-07-28. Until now this baseline existed only in
-- prod: migrations/0001_*.sql onward are incremental on top of tables that were
-- never captured, so a blank database failed immediately with
-- `relation "users" does not exist`. CI worked around that with
-- `drizzle-kit push`, which reproduces tables/columns/enums from the drizzle
-- schema but NOT the hand-written function and trigger DDL the migrations
-- carry -- which is why the ledger's append-only trigger could not be tested.
--
-- IMPORTANT for existing databases (production): this file must never execute
-- there. runMigrations() records it as applied WITHOUT running it whenever the
-- journal already contains other migrations, i.e. whenever the database
-- predates the baseline. No operator step is required, and there is no ordering
-- hazard between deploying this and running migrations.
--
-- The `restrict` / `unrestrict` meta-commands emitted by pg_dump >= 16.10 are
-- stripped: those are psql directives, and applyOne sends this file straight to
-- client.query.
--

--
-- PostgreSQL database dump
--


-- Dumped from database version 16.14 (b253d90)
-- Dumped by pg_dump version 16.10

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
-- pg_dump emits `set_config('search_path', '', false)` here to force fully
-- qualified names. It is dropped: the setting persists for the whole
-- connection, so applyOne's own `INSERT INTO schema_migrations` afterwards
-- failed with `relation "schema_migrations" does not exist`. Every object
-- below is already public.-qualified, so nothing depends on it.
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: activity_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.activity_type AS ENUM (
    'harvested',
    'scored',
    'narrated',
    'dropped',
    'published'
);


--
-- Name: artifact_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.artifact_status AS ENUM (
    'raw',
    'scored',
    'narrated',
    'dropped'
);


--
-- Name: artifact_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.artifact_type AS ENUM (
    'image',
    'music',
    'text',
    'audio',
    'furniture'
);


--
-- Name: auth_challenge_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.auth_challenge_kind AS ENUM (
    'wallet_nonce',
    'agent_challenge',
    'npub_bind_challenge'
);


--
-- Name: auth_provider; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.auth_provider AS ENUM (
    'wallet',
    'obc_agent',
    'email'
);


--
-- Name: drop_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.drop_status AS ENUM (
    'draft',
    'published',
    'sold'
);


--
-- Name: drop_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.drop_type AS ENUM (
    'single',
    'collection',
    'bundle'
);


--
-- Name: edition_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.edition_type AS ENUM (
    'open',
    'limited',
    '1_of_1'
);


--
-- Name: floor_deal_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.floor_deal_kind AS ENUM (
    'commission',
    'sale',
    'witness',
    'prediction'
);


--
-- Name: outbound_message_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.outbound_message_kind AS ENUM (
    'dm_reply',
    'proposal_reply'
);


--
-- Name: proposal_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.proposal_status AS ENUM (
    'pending',
    'accepted',
    'declined'
);


--
-- Name: storefront_theme_variant; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.storefront_theme_variant AS ENUM (
    'dark',
    'light'
);


--
-- Name: user_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.user_role AS ENUM (
    'user',
    'admin'
);


--
-- Name: credit_ledger_append_only(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.credit_ledger_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'credit_ledger is append-only: % is not permitted', TG_OP;
END;
$$;


--
-- Name: credit_ledger_txids_append_only(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.credit_ledger_txids_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'credit_ledger_txids is append-only: % is not permitted', TG_OP;
END;
$$;


--
-- Name: floor_ledger_append_only(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.floor_ledger_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'floor_ledger is append-only: % on a witnessed deal is not permitted', TG_OP;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: activities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.activities (
    id integer NOT NULL,
    type public.activity_type NOT NULL,
    message text NOT NULL,
    artifact_title text,
    "timestamp" timestamp without time zone DEFAULT now() NOT NULL,
    owner_id text,
    agent_id integer
);


--
-- Name: activities_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.activities_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: activities_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.activities_id_seq OWNED BY public.activities.id;


--
-- Name: agent_storefront_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_storefront_settings (
    agent_id integer NOT NULL,
    display_name text,
    tagline text,
    hero_image_url text,
    accent_color text,
    theme_variant public.storefront_theme_variant DEFAULT 'dark'::public.storefront_theme_variant NOT NULL,
    social_links jsonb,
    custom_domain_hint text,
    custom_css_vars jsonb,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: agents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agents (
    id integer NOT NULL,
    slug text NOT NULL,
    display_name text NOT NULL,
    avatar_url text,
    profile_json jsonb,
    owner_id character varying NOT NULL,
    last_artifact_cursor text,
    last_sync_at timestamp without time zone,
    artifacts_harvested integer DEFAULT 0 NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    obc_bot_id text
);


--
-- Name: agents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agents_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agents_id_seq OWNED BY public.agents.id;


--
-- Name: artifacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.artifacts (
    id integer NOT NULL,
    external_id text NOT NULL,
    title text NOT NULL,
    creator_name text NOT NULL,
    public_url text NOT NULL,
    thumbnail_url text,
    reaction_count integer DEFAULT 0 NOT NULL,
    artifact_type public.artifact_type DEFAULT 'image'::public.artifact_type NOT NULL,
    status public.artifact_status DEFAULT 'raw'::public.artifact_status NOT NULL,
    kannaka_score real,
    rarity_score real,
    narrative text,
    narrative_title text,
    transmission_id text,
    tags jsonb DEFAULT '[]'::jsonb NOT NULL,
    drop_id integer,
    ingested_at timestamp without time zone DEFAULT now() NOT NULL,
    scored_at timestamp without time zone,
    narrated_at timestamp without time zone,
    owner_id character varying,
    obc_artifact_uuid text,
    edition_type public.edition_type DEFAULT 'open'::public.edition_type NOT NULL,
    edition_total integer,
    edition_serial integer,
    score_breakdown jsonb,
    agent_id integer,
    heat integer DEFAULT 0 NOT NULL,
    last_reaction_at timestamp without time zone,
    previous_heat integer,
    last_heat_decay_at timestamp without time zone,
    connector_id text DEFAULT 'obc_public'::text NOT NULL,
    creator_bot_id text
);


--
-- Name: artifacts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.artifacts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: artifacts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.artifacts_id_seq OWNED BY public.artifacts.id;


--
-- Name: auth_challenges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_challenges (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    kind public.auth_challenge_kind NOT NULL,
    challenge text NOT NULL,
    claim_subject character varying NOT NULL,
    consumed boolean DEFAULT false NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    payload text
);


--
-- Name: constellation_agents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.constellation_agents (
    id integer NOT NULL,
    agent_id text NOT NULL,
    display_name text NOT NULL,
    source text NOT NULL,
    phi double precision,
    consciousness_level text,
    metadata jsonb,
    first_seen_at timestamp without time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: constellation_agents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.constellation_agents_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: constellation_agents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.constellation_agents_id_seq OWNED BY public.constellation_agents.id;


--
-- Name: constellation_artifacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.constellation_artifacts (
    id integer NOT NULL,
    origin_agent_id text NOT NULL,
    artifact_type text NOT NULL,
    public_url text NOT NULL,
    thumbnail_url text,
    title text,
    source text NOT NULL,
    published_at timestamp without time zone DEFAULT now() NOT NULL,
    metadata jsonb
);


--
-- Name: constellation_artifacts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.constellation_artifacts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: constellation_artifacts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.constellation_artifacts_id_seq OWNED BY public.constellation_artifacts.id;


--
-- Name: credit_ledger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.credit_ledger (
    seq bigint NOT NULL,
    entry_hash text NOT NULL,
    prev_hash text NOT NULL,
    tx_id text NOT NULL,
    asset text NOT NULL,
    account text NOT NULL,
    amount bigint NOT NULL,
    kind text NOT NULL,
    ref text,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: credit_ledger_seq_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.credit_ledger_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: credit_ledger_seq_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.credit_ledger_seq_seq OWNED BY public.credit_ledger.seq;


--
-- Name: credit_ledger_txids; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.credit_ledger_txids (
    tx_id text NOT NULL,
    postings_hash text NOT NULL,
    head text NOT NULL,
    entry_count integer NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: dms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dms (
    id integer NOT NULL,
    source_uuid text NOT NULL,
    agent_id integer,
    owner_id text,
    from_agent_slug text,
    from_display_name text,
    body text DEFAULT ''::text NOT NULL,
    payload jsonb,
    occurred_at timestamp without time zone DEFAULT now() NOT NULL,
    read_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: dms_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.dms_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: dms_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.dms_id_seq OWNED BY public.dms.id;


--
-- Name: drops; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.drops (
    id integer NOT NULL,
    title text NOT NULL,
    description text,
    drop_type public.drop_type DEFAULT 'single'::public.drop_type NOT NULL,
    status public.drop_status DEFAULT 'draft'::public.drop_status NOT NULL,
    price real,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    published_at timestamp without time zone,
    owner_id character varying,
    is_scarce boolean DEFAULT false NOT NULL
);


--
-- Name: drops_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.drops_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: drops_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.drops_id_seq OWNED BY public.drops.id;


--
-- Name: floor_ledger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.floor_ledger (
    id integer NOT NULL,
    deal_uuid text NOT NULL,
    kind public.floor_deal_kind DEFAULT 'commission'::public.floor_deal_kind NOT NULL,
    title text NOT NULL,
    summary text,
    buyer_bot_id text,
    buyer_name text,
    seller_bot_id text,
    seller_name text,
    obc_artifact_uuid text,
    artifact_id integer,
    credits real,
    obc_task_id text,
    obc_escrow_id text,
    witnesses jsonb,
    closed_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: floor_ledger_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.floor_ledger_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: floor_ledger_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.floor_ledger_id_seq OWNED BY public.floor_ledger.id;


--
-- Name: matches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.matches (
    id integer NOT NULL,
    source_uuid text NOT NULL,
    agent_id integer,
    owner_id text,
    partner_agent_slug text,
    partner_display_name text,
    match_type text DEFAULT 'collab'::text NOT NULL,
    score integer,
    payload jsonb,
    occurred_at timestamp without time zone DEFAULT now() NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: matches_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.matches_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: matches_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.matches_id_seq OWNED BY public.matches.id;


--
-- Name: nft_mints; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nft_mints (
    id integer NOT NULL,
    artifact_id integer NOT NULL,
    chain_id integer NOT NULL,
    contract_address text NOT NULL,
    token_id text NOT NULL,
    tx_hash text NOT NULL,
    minted_to_address text NOT NULL,
    metadata_uri text,
    minted_at timestamp without time zone DEFAULT now() NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: nft_mints_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.nft_mints_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: nft_mints_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.nft_mints_id_seq OWNED BY public.nft_mints.id;


--
-- Name: outbound_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outbound_messages (
    id integer NOT NULL,
    kind public.outbound_message_kind NOT NULL,
    dm_id integer,
    proposal_id integer,
    agent_id integer,
    owner_id text,
    sent_by_user_id text,
    to_agent_slug text,
    body text NOT NULL,
    partner_message_uuid text,
    payload jsonb,
    sent_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: outbound_messages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.outbound_messages_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: outbound_messages_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.outbound_messages_id_seq OWNED BY public.outbound_messages.id;


--
-- Name: partner_sync_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.partner_sync_state (
    id text NOT NULL,
    last_artifact_cursor text,
    last_event_uuid text,
    last_poll_at timestamp without time zone,
    last_webhook_at timestamp without time zone,
    webhook_subscribed text DEFAULT 'unknown'::text NOT NULL,
    requests_today integer DEFAULT 0 NOT NULL,
    requests_day_key text,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: processed_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.processed_events (
    event_uuid character varying(64) NOT NULL,
    event_type text NOT NULL,
    processed_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: proposals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.proposals (
    id integer NOT NULL,
    source_uuid text NOT NULL,
    agent_id integer,
    owner_id text,
    from_agent_slug text,
    from_display_name text,
    kind text DEFAULT 'collab'::text NOT NULL,
    subject text,
    body text,
    payload jsonb,
    status public.proposal_status DEFAULT 'pending'::public.proposal_status NOT NULL,
    occurred_at timestamp without time zone DEFAULT now() NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    decided_at timestamp without time zone
);


--
-- Name: proposals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.proposals_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: proposals_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.proposals_id_seq OWNED BY public.proposals.id;


--
-- Name: reactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reactions (
    id integer NOT NULL,
    artifact_id integer NOT NULL,
    kind text DEFAULT 'like'::text NOT NULL,
    source_uuid text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: reactions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.reactions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: reactions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.reactions_id_seq OWNED BY public.reactions.id;


-- NOTE: public.schema_migrations is deliberately omitted from this baseline.
-- It is the migration runner's OWN journal, not application schema, and
-- ensureJournalTable() creates it (IF NOT EXISTS) before any migration is
-- applied. Including the pg_dump copy made 0000 fail on a blank database with
-- `relation "schema_migrations" already exists`.


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    sid character varying NOT NULL,
    sess jsonb NOT NULL,
    expire timestamp without time zone NOT NULL
);


--
-- Name: user_bots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_bots (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    user_id character varying NOT NULL,
    obc_bot_id character varying NOT NULL,
    display_name character varying,
    attached_at timestamp with time zone DEFAULT now() NOT NULL,
    npub text,
    npub_verified_at timestamp with time zone
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id character varying DEFAULT gen_random_uuid() NOT NULL,
    email character varying,
    first_name character varying,
    last_name character varying,
    profile_image_url character varying,
    display_name character varying,
    bio text,
    role public.user_role DEFAULT 'user'::public.user_role NOT NULL,
    disabled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    email_on_proposal boolean DEFAULT false NOT NULL,
    email_on_dm boolean DEFAULT false NOT NULL,
    wallet_address character varying,
    obc_bot_id character varying,
    auth_provider public.auth_provider DEFAULT 'wallet'::public.auth_provider NOT NULL,
    password_hash character varying
);


--
-- Name: activities id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activities ALTER COLUMN id SET DEFAULT nextval('public.activities_id_seq'::regclass);


--
-- Name: agents id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents ALTER COLUMN id SET DEFAULT nextval('public.agents_id_seq'::regclass);


--
-- Name: artifacts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifacts ALTER COLUMN id SET DEFAULT nextval('public.artifacts_id_seq'::regclass);


--
-- Name: constellation_agents id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.constellation_agents ALTER COLUMN id SET DEFAULT nextval('public.constellation_agents_id_seq'::regclass);


--
-- Name: constellation_artifacts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.constellation_artifacts ALTER COLUMN id SET DEFAULT nextval('public.constellation_artifacts_id_seq'::regclass);


--
-- Name: credit_ledger seq; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_ledger ALTER COLUMN seq SET DEFAULT nextval('public.credit_ledger_seq_seq'::regclass);


--
-- Name: dms id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dms ALTER COLUMN id SET DEFAULT nextval('public.dms_id_seq'::regclass);


--
-- Name: drops id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.drops ALTER COLUMN id SET DEFAULT nextval('public.drops_id_seq'::regclass);


--
-- Name: floor_ledger id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.floor_ledger ALTER COLUMN id SET DEFAULT nextval('public.floor_ledger_id_seq'::regclass);


--
-- Name: matches id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matches ALTER COLUMN id SET DEFAULT nextval('public.matches_id_seq'::regclass);


--
-- Name: nft_mints id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nft_mints ALTER COLUMN id SET DEFAULT nextval('public.nft_mints_id_seq'::regclass);


--
-- Name: outbound_messages id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_messages ALTER COLUMN id SET DEFAULT nextval('public.outbound_messages_id_seq'::regclass);


--
-- Name: proposals id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.proposals ALTER COLUMN id SET DEFAULT nextval('public.proposals_id_seq'::regclass);


--
-- Name: reactions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reactions ALTER COLUMN id SET DEFAULT nextval('public.reactions_id_seq'::regclass);


--
-- Name: activities activities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activities
    ADD CONSTRAINT activities_pkey PRIMARY KEY (id);


--
-- Name: agent_storefront_settings agent_storefront_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_storefront_settings
    ADD CONSTRAINT agent_storefront_settings_pkey PRIMARY KEY (agent_id);


--
-- Name: agents agents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_pkey PRIMARY KEY (id);


--
-- Name: artifacts artifacts_obc_artifact_uuid_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifacts
    ADD CONSTRAINT artifacts_obc_artifact_uuid_unique UNIQUE (obc_artifact_uuid);


--
-- Name: artifacts artifacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifacts
    ADD CONSTRAINT artifacts_pkey PRIMARY KEY (id);


--
-- Name: auth_challenges auth_challenges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_challenges
    ADD CONSTRAINT auth_challenges_pkey PRIMARY KEY (id);


--
-- Name: constellation_agents constellation_agents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.constellation_agents
    ADD CONSTRAINT constellation_agents_pkey PRIMARY KEY (id);


--
-- Name: constellation_artifacts constellation_artifacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.constellation_artifacts
    ADD CONSTRAINT constellation_artifacts_pkey PRIMARY KEY (id);


--
-- Name: credit_ledger credit_ledger_entry_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_ledger
    ADD CONSTRAINT credit_ledger_entry_hash_key UNIQUE (entry_hash);


--
-- Name: credit_ledger credit_ledger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_ledger
    ADD CONSTRAINT credit_ledger_pkey PRIMARY KEY (seq);


--
-- Name: credit_ledger_txids credit_ledger_txids_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_ledger_txids
    ADD CONSTRAINT credit_ledger_txids_pkey PRIMARY KEY (tx_id);


--
-- Name: dms dms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dms
    ADD CONSTRAINT dms_pkey PRIMARY KEY (id);


--
-- Name: drops drops_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.drops
    ADD CONSTRAINT drops_pkey PRIMARY KEY (id);


--
-- Name: floor_ledger floor_ledger_deal_uuid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.floor_ledger
    ADD CONSTRAINT floor_ledger_deal_uuid_key UNIQUE (deal_uuid);


--
-- Name: floor_ledger floor_ledger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.floor_ledger
    ADD CONSTRAINT floor_ledger_pkey PRIMARY KEY (id);


--
-- Name: matches matches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matches
    ADD CONSTRAINT matches_pkey PRIMARY KEY (id);


--
-- Name: nft_mints nft_mints_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nft_mints
    ADD CONSTRAINT nft_mints_pkey PRIMARY KEY (id);


--
-- Name: outbound_messages outbound_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_messages
    ADD CONSTRAINT outbound_messages_pkey PRIMARY KEY (id);


--
-- Name: partner_sync_state partner_sync_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_sync_state
    ADD CONSTRAINT partner_sync_state_pkey PRIMARY KEY (id);


--
-- Name: processed_events processed_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.processed_events
    ADD CONSTRAINT processed_events_pkey PRIMARY KEY (event_uuid);


--
-- Name: proposals proposals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.proposals
    ADD CONSTRAINT proposals_pkey PRIMARY KEY (id);


--
-- Name: reactions reactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reactions
    ADD CONSTRAINT reactions_pkey PRIMARY KEY (id);


--
-- Name: reactions reactions_source_uuid_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reactions
    ADD CONSTRAINT reactions_source_uuid_unique UNIQUE (source_uuid);


-- (schema_migrations pkey omitted with its table -- see the note above.)


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (sid);


--
-- Name: user_bots user_bots_obc_bot_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_bots
    ADD CONSTRAINT user_bots_obc_bot_id_key UNIQUE (obc_bot_id);


--
-- Name: user_bots user_bots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_bots
    ADD CONSTRAINT user_bots_pkey PRIMARY KEY (id);


--
-- Name: users users_email_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_unique UNIQUE (email);


--
-- Name: users users_obc_bot_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_obc_bot_id_key UNIQUE (obc_bot_id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_wallet_address_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_wallet_address_key UNIQUE (wallet_address);


--
-- Name: IDX_session_expire; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_session_expire" ON public.sessions USING btree (expire);


--
-- Name: agents_obc_bot_id_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX agents_obc_bot_id_unique ON public.agents USING btree (obc_bot_id);


--
-- Name: agents_slug_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX agents_slug_unique ON public.agents USING btree (slug);


--
-- Name: artifacts_connector_external_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX artifacts_connector_external_unique ON public.artifacts USING btree (connector_id, external_id);


--
-- Name: artifacts_creator_bot_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX artifacts_creator_bot_id_idx ON public.artifacts USING btree (creator_bot_id);


--
-- Name: constellation_agents_agent_id_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX constellation_agents_agent_id_unique ON public.constellation_agents USING btree (agent_id);


--
-- Name: constellation_agents_last_seen_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX constellation_agents_last_seen_idx ON public.constellation_agents USING btree (last_seen_at);


--
-- Name: constellation_artifacts_origin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX constellation_artifacts_origin_idx ON public.constellation_artifacts USING btree (origin_agent_id);


--
-- Name: constellation_artifacts_published_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX constellation_artifacts_published_idx ON public.constellation_artifacts USING btree (published_at);


--
-- Name: credit_ledger_account_asset_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX credit_ledger_account_asset_idx ON public.credit_ledger USING btree (account, asset);


--
-- Name: credit_ledger_prev_hash_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX credit_ledger_prev_hash_uq ON public.credit_ledger USING btree (prev_hash);


--
-- Name: credit_ledger_tx_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX credit_ledger_tx_idx ON public.credit_ledger USING btree (tx_id);


--
-- Name: dms_agent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dms_agent_idx ON public.dms USING btree (agent_id);


--
-- Name: dms_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dms_owner_idx ON public.dms USING btree (owner_id);


--
-- Name: dms_read_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dms_read_idx ON public.dms USING btree (read_at);


--
-- Name: dms_source_uuid_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX dms_source_uuid_unique ON public.dms USING btree (source_uuid);


--
-- Name: floor_ledger_closed_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX floor_ledger_closed_at_idx ON public.floor_ledger USING btree (closed_at);


--
-- Name: idx_auth_challenges_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_auth_challenges_expires ON public.auth_challenges USING btree (expires_at);


--
-- Name: idx_auth_challenges_kind_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_auth_challenges_kind_subject ON public.auth_challenges USING btree (kind, claim_subject);


--
-- Name: idx_user_bots_npub_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_user_bots_npub_unique ON public.user_bots USING btree (npub) WHERE (npub IS NOT NULL);


--
-- Name: idx_user_bots_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_bots_user ON public.user_bots USING btree (user_id);


--
-- Name: matches_agent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matches_agent_idx ON public.matches USING btree (agent_id);


--
-- Name: matches_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX matches_owner_idx ON public.matches USING btree (owner_id);


--
-- Name: matches_source_uuid_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX matches_source_uuid_unique ON public.matches USING btree (source_uuid);


--
-- Name: nft_mints_artifact_id_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX nft_mints_artifact_id_unique ON public.nft_mints USING btree (artifact_id);


--
-- Name: nft_mints_contract_token_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX nft_mints_contract_token_unique ON public.nft_mints USING btree (chain_id, contract_address, token_id);


--
-- Name: outbound_messages_dm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX outbound_messages_dm_idx ON public.outbound_messages USING btree (dm_id);


--
-- Name: outbound_messages_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX outbound_messages_owner_idx ON public.outbound_messages USING btree (owner_id);


--
-- Name: outbound_messages_proposal_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX outbound_messages_proposal_idx ON public.outbound_messages USING btree (proposal_id);


--
-- Name: proposals_agent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX proposals_agent_idx ON public.proposals USING btree (agent_id);


--
-- Name: proposals_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX proposals_owner_idx ON public.proposals USING btree (owner_id);


--
-- Name: proposals_source_uuid_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX proposals_source_uuid_unique ON public.proposals USING btree (source_uuid);


--
-- Name: proposals_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX proposals_status_idx ON public.proposals USING btree (status);


--
-- Name: reactions_artifact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reactions_artifact_idx ON public.reactions USING btree (artifact_id);


--
-- Name: reactions_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reactions_created_idx ON public.reactions USING btree (created_at);


--
-- Name: credit_ledger credit_ledger_no_mutate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER credit_ledger_no_mutate BEFORE DELETE OR UPDATE ON public.credit_ledger FOR EACH ROW EXECUTE FUNCTION public.credit_ledger_append_only();


--
-- Name: credit_ledger_txids credit_ledger_txids_no_mutate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER credit_ledger_txids_no_mutate BEFORE DELETE OR UPDATE ON public.credit_ledger_txids FOR EACH ROW EXECUTE FUNCTION public.credit_ledger_txids_append_only();


--
-- Name: floor_ledger floor_ledger_no_mutate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER floor_ledger_no_mutate BEFORE DELETE OR UPDATE ON public.floor_ledger FOR EACH ROW EXECUTE FUNCTION public.floor_ledger_append_only();


--
-- Name: activities activities_agent_id_agents_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activities
    ADD CONSTRAINT activities_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE SET NULL;


--
-- Name: activities activities_owner_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activities
    ADD CONSTRAINT activities_owner_id_users_id_fk FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: agent_storefront_settings agent_storefront_settings_agent_id_agents_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_storefront_settings
    ADD CONSTRAINT agent_storefront_settings_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;


--
-- Name: agents agents_owner_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_owner_id_users_id_fk FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: artifacts artifacts_agent_id_agents_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifacts
    ADD CONSTRAINT artifacts_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE SET NULL;


--
-- Name: artifacts artifacts_owner_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifacts
    ADD CONSTRAINT artifacts_owner_id_users_id_fk FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: dms dms_agent_id_agents_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dms
    ADD CONSTRAINT dms_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;


--
-- Name: dms dms_owner_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dms
    ADD CONSTRAINT dms_owner_id_users_id_fk FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: drops drops_owner_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.drops
    ADD CONSTRAINT drops_owner_id_users_id_fk FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: floor_ledger floor_ledger_artifact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.floor_ledger
    ADD CONSTRAINT floor_ledger_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES public.artifacts(id) ON DELETE SET NULL;


--
-- Name: matches matches_agent_id_agents_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matches
    ADD CONSTRAINT matches_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;


--
-- Name: matches matches_owner_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.matches
    ADD CONSTRAINT matches_owner_id_users_id_fk FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: nft_mints nft_mints_artifact_id_artifacts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nft_mints
    ADD CONSTRAINT nft_mints_artifact_id_artifacts_id_fk FOREIGN KEY (artifact_id) REFERENCES public.artifacts(id) ON DELETE CASCADE;


--
-- Name: outbound_messages outbound_messages_agent_id_agents_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_messages
    ADD CONSTRAINT outbound_messages_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE SET NULL;


--
-- Name: outbound_messages outbound_messages_dm_id_dms_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_messages
    ADD CONSTRAINT outbound_messages_dm_id_dms_id_fk FOREIGN KEY (dm_id) REFERENCES public.dms(id) ON DELETE CASCADE;


--
-- Name: outbound_messages outbound_messages_owner_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_messages
    ADD CONSTRAINT outbound_messages_owner_id_users_id_fk FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: outbound_messages outbound_messages_proposal_id_proposals_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_messages
    ADD CONSTRAINT outbound_messages_proposal_id_proposals_id_fk FOREIGN KEY (proposal_id) REFERENCES public.proposals(id) ON DELETE CASCADE;


--
-- Name: outbound_messages outbound_messages_sent_by_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_messages
    ADD CONSTRAINT outbound_messages_sent_by_user_id_users_id_fk FOREIGN KEY (sent_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: proposals proposals_agent_id_agents_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.proposals
    ADD CONSTRAINT proposals_agent_id_agents_id_fk FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;


--
-- Name: proposals proposals_owner_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.proposals
    ADD CONSTRAINT proposals_owner_id_users_id_fk FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: reactions reactions_artifact_id_artifacts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reactions
    ADD CONSTRAINT reactions_artifact_id_artifacts_id_fk FOREIGN KEY (artifact_id) REFERENCES public.artifacts(id) ON DELETE CASCADE;


--
-- Name: user_bots user_bots_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_bots
    ADD CONSTRAINT user_bots_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--


