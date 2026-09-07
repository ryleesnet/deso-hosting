-- DeSo Hosting schema for self-hosted Supabase / Postgres.
-- Idempotent: safe to re-run via `npm run db:migrate`.
-- Tables live in `public`. RLS is enabled with no anon policies; the Node
-- server connects as the table owner (postgres / service_role) which bypasses RLS.

create table if not exists services (
  id text primary key,
  name text not null,
  description text not null default '',
  vcpu integer not null,
  ram integer not null,
  storage integer not null,
  price_usd_cents integer,
  price_nanos bigint,
  proxmox_template integer,
  proxmox_node text,
  image_profiles jsonb,
  active boolean not null default true,
  testing boolean,
  created_at text not null
);

create table if not exists orders (
  id text primary key,
  user_id text not null,
  service_id text not null,
  vmid integer not null default 0,
  node text not null default '',
  status text not null,
  created_at text not null,
  cancelled_at text,
  expires_at text,
  vm_login_username text,
  vm_login_password text,
  vm_display_name text,
  extra_disks_gb jsonb,
  clone_template_vmid integer,
  clone_image_profile_id text,
  image_profiles jsonb,
  public_ipv4 text,
  cloud_init_ssh_keys text,
  provision_error text,
  private_lan_enabled boolean,
  private_lan_vlan integer,
  private_lan_ip text,
  adjusting_plan boolean,
  hardware_maintenance boolean,
  backup_restore_in_progress boolean,
  payment_provider text,
  paypal_subscription_id text,
  paypal_plan_id text,
  paypal_payer_email text,
  paypal_monthly_usd_cents integer
);

create index if not exists orders_user_id_idx on orders (user_id);
create index if not exists orders_status_idx on orders (status);
create index if not exists orders_paypal_subscription_id_idx on orders (paypal_subscription_id);

create table if not exists subscriptions (
  id text primary key,
  order_id text not null,
  user_id text not null,
  last_payment_at text not null,
  next_payment_at text not null,
  amount_nanos bigint not null,
  status text not null,
  payment_provider text,
  paypal_subscription_id text
);

create index if not exists subscriptions_order_id_idx on subscriptions (order_id);
create index if not exists subscriptions_user_id_idx on subscriptions (user_id);

create table if not exists renewal_txs (
  tx_hash_hex text primary key,
  order_id text,
  subscription_id text,
  amount_nanos bigint not null,
  months integer,
  payment_token text,
  order_ids jsonb,
  subscription_ids jsonb,
  usd_cents integer,
  processed_at text not null
);

create table if not exists billing_dm_notifications (
  id text primary key,
  order_id text not null,
  subscription_id text not null,
  user_id text not null,
  kind text not null,
  billing_anchor_date text not null,
  sent_at text not null
);

create table if not exists os_templates (
  id text primary key,
  label text not null,
  template_vmid integer,
  image_file text not null,
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at text not null
);

create table if not exists paypal_plans (
  id text primary key,
  service_id text not null,
  monthly_usd_cents integer not null,
  env text not null,
  paypal_product_id text not null,
  paypal_plan_id text not null,
  created_at text not null
);

create table if not exists paypal_events (
  event_id text primary key,
  event_type text not null,
  processed_at text not null
);

create table if not exists admin_public_keys (
  public_key text primary key,
  added_at text not null,
  added_by text
);

create table if not exists public_ips (
  address text primary key,
  status text not null,
  user_id text,
  order_id text,
  vmid integer,
  node text,
  notes text,
  assigned_at text,
  created_at text not null,
  updated_at text not null
);

create index if not exists public_ips_status_idx on public_ips (status);
create index if not exists public_ips_order_id_idx on public_ips (order_id);

create table if not exists public_ips_config (
  id text primary key,
  gateway text,
  prefix_len integer,
  dns text,
  updated_at text
);

create table if not exists proxmox_host_config (
  id text primary key,
  default_clone_node text,
  auto_place_new_vms boolean,
  default_disk_storage text,
  backup_storage text,
  updated_at text
);

create table if not exists user_private_networks (
  id text primary key,
  user_id text not null unique,
  vlan_tag integer not null unique,
  created_at text not null
);

alter table services enable row level security;
alter table orders enable row level security;
alter table subscriptions enable row level security;
alter table renewal_txs enable row level security;
alter table billing_dm_notifications enable row level security;
alter table os_templates enable row level security;
alter table paypal_plans enable row level security;
alter table paypal_events enable row level security;
alter table admin_public_keys enable row level security;
alter table public_ips enable row level security;
alter table public_ips_config enable row level security;
alter table proxmox_host_config enable row level security;
alter table user_private_networks enable row level security;
