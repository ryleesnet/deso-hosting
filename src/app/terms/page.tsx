import type { Metadata } from "next";
import Link from "next/link";
import { ORDER_TERMS_REVISION } from "@/lib/terms-revision";

export const metadata: Metadata = {
  title: "Terms of Service | DeSoHosting",
  description:
    "Terms of Service and Acceptable Use Policy for DeSoHosting VPS services.",
};

export default function TermsPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-14 lg:px-8">
      <p className="text-sm text-[var(--muted)]">
        <Link href="/" className="text-[var(--accent)] hover:underline">
          ← Home
        </Link>
      </p>
      <h1 className="mt-6 text-2xl font-bold tracking-tight sm:text-3xl">
        Terms of Service & Acceptable Use Policy
      </h1>
      <p className="mt-2 text-sm text-[var(--muted)]">
        Last Updated: 05/21/2026 · Revision{" "}
        <span className="font-mono text-xs">{ORDER_TERMS_REVISION}</span>
      </p>

      <div className="mt-8 max-w-none space-y-8 leading-relaxed">
        <p className="text-[var(--muted)]">
          Welcome to DeSoHosting (&quot;Company&quot;, &quot;we&quot;, &quot;us&quot;, or
          &quot;our&quot;). These Terms of Service (&quot;Terms&quot;) govern your access to
          and use of our website, customer portal, and the Virtual Private Server (VPS)
          hosting infrastructure provided by us (collectively, the
          &quot;Services&quot;).
        </p>
        <p className="text-[var(--muted)]">
          By purchasing, provisioning, or using our Services, you agree to be bound by
          these Terms. If you are accepting these Terms on behalf of a business or
          entity, you represent that you have the authority to bind that entity.
        </p>

        <section>
          <h2 className="text-lg font-semibold text-[var(--foreground)]">
            1. Eligibility and Account Responsibilities
          </h2>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-[var(--muted)]">
            <li>
              <strong className="text-[var(--foreground)]">
                Account Verification:
              </strong>{" "}
              We reserve the right to verify your identity (including phone or billing
              checks) before provisioning infrastructure to prevent fraud and abuse.
            </li>
            <li>
              <strong className="text-[var(--foreground)]">Security:</strong> You are
              solely responsible for managing the security of your VPS instances,
              including root passwords, SSH keys, firewall configurations, and keeping
              your installed operating systems and software patched.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[var(--foreground)]">
            2. Strict Acceptable Use Policy (AUP)
          </h2>
          <p className="mt-3 text-[var(--muted)]">
            Your VPS instances must be used for lawful purposes only. We maintain a
            zero-tolerance policy for network abuse or illegal activities.
          </p>
          <p className="mt-3 font-medium text-[var(--foreground)]">
            Prohibited Actions include, but are not limited to:
          </p>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-[var(--muted)]">
            <li>
              <strong className="text-[var(--foreground)]">Illegal Activity:</strong>{" "}
              Hosting, distributing, or linking to copyrighted material without
              authorization (piracy/warez), child exploitation material, fraudulent
              schemes, or any content that violates local, federal, or international
              laws.
            </li>
            <li>
              <strong className="text-[var(--foreground)]">Network Attacks:</strong>{" "}
              Launching or participating in Denial of Service (DoS/DDoS) attacks,
              network scanning, port scanning, or sniffing from your VPS.
            </li>
            <li>
              <strong className="text-[var(--foreground)]">
                Spam and Bulk Email:
              </strong>{" "}
              Operating open mail relays or sending unsolicited bulk email (SPAM). All
              outbound mail must comply with the CAN-SPAM Act.
            </li>
            <li>
              <strong className="text-[var(--foreground)]">
                Malicious Software:
              </strong>{" "}
              Hosting, executing, or distributing malware, trojans, rootkits, botnet
              controllers, or phishing pages.
            </li>
            <li>
              <strong className="text-[var(--foreground)]">Resource Abuse:</strong>{" "}
              Consistent, intentional overuse of shared host node resources (such as
              excessive, long-term disk I/O or network saturation) that negatively impacts
              neighboring clients on the same hardware node.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[var(--foreground)]">
            3. Immediate Suspension and Termination
          </h2>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-[var(--muted)]">
            <li>
              <strong className="text-[var(--foreground)]">
                The Right to Suspend:
              </strong>{" "}
              If we receive a verified abuse complaint (such as a DMCA takedown notice,
              Spamhaus listing, or network attack report) or detect activity violating
              Section 2, we reserve the right to immediately suspend or terminate your
              VPS without prior notice.
            </li>
            <li>
              <strong className="text-[var(--foreground)]">Data Loss:</strong> In the
              event of an abuse-related suspension or termination, we are not
              responsible for preserving your data, and backups may be deleted.
            </li>
            <li>
              <strong className="text-[var(--foreground)]">
                No Refunds for Abuse:
              </strong>{" "}
              If your account is closed due to a violation of our AUP, you forfeit any
              remaining credit or prepayments.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[var(--foreground)]">
            4. Backups and Data Loss
          </h2>
          <p className="mt-3 font-semibold uppercase tracking-wide text-amber-400/95">
            Critical data disclaimer
          </p>
          <p className="mt-2 text-[var(--muted)]">
            While we strive to maintain high availability across our host
            infrastructure, you are solely responsible for maintaining your own offsite
            backups. We provide the underlying virtual machine framework &quot;as
            is.&quot; In the event of hardware failure, storage corruption, or
            catastrophic loss, we are not liable for lost data, files, or
            configurations.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[var(--foreground)]">
            5. Resource Allocation and Fair Use
          </h2>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-[var(--muted)]">
            <li>
              <strong className="text-[var(--foreground)]">
                Burst vs. Sustained:
              </strong>{" "}
              CPU cores, port speeds, and disk I/O are typically shared among multiple
              virtual environments on a single physical server. While you are allocated
              specific limits, sustained utilization that degrades host node performance
              may result in temporary resource throttling or a request to upgrade to a
              dedicated tier.
            </li>
            <li>
              <strong className="text-[var(--foreground)]">IP Addresses:</strong> All
              IPv4 and IPv6 addresses assigned to your VPS remain the property of the
              Company and its upstream network providers. We reserve the right to alter
              or reclaim IP allocations for network engineering or clean reputation
              purposes.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[var(--foreground)]">
            6. Billing, Cancellation, and Refunds
          </h2>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-[var(--muted)]">
            <li>
              <strong className="text-[var(--foreground)]">Payment Terms:</strong>{" "}
              Services are billed on a recurring basis (monthly, quarterly, or
              annually). Payments are due on the renewal date. Failure to pay within 30
              days of the due date will result in automated suspension; termination and
              data deletion will occur after 60 days.
            </li>
            <li>
              <strong className="text-[var(--foreground)]">Refund Policy:</strong>{" "}
              All sales are final
            </li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[var(--foreground)]">
            7. Limitation of Liability
          </h2>
          <p className="mt-3 text-[var(--muted)]">
            To the maximum extent permitted by law, DeSoHosting shall not be liable for
            any direct, indirect, incidental, or consequential damages—including but not
            limited to loss of profits, business interruption, or data corruption—arising
            out of the use or inability to use our VPS infrastructure, even if we have
            been advised of the possibility of such damages.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[var(--foreground)]">
            8. Governing Law
          </h2>
          <p className="mt-3 text-[var(--muted)]">
            These Terms shall be governed by and construed in accordance with the laws of
            Tennessee, USA, without regard to its conflict of law principles. Any legal
            action arising from these terms must be filed in the courts located within
            Nashville, TN, USA.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-[var(--foreground)]">
            9. Contact and Abuse Reporting
          </h2>
          <p className="mt-3 text-[var(--muted)]">
            For legal inquiries or to report infrastructure abuse originating from our
            network, contact:
          </p>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-[var(--muted)]">
            <li>
              <strong className="text-[var(--foreground)]">
                Legal Support Email:
              </strong>{" "}
              <a
                href="mailto:randerson@rylees.net"
                className="break-all text-[var(--accent)] hover:underline"
              >
                randerson@rylees.net
              </a>
            </li>
            <li>
              <strong className="text-[var(--foreground)]">Abuse Desk Email:</strong>{" "}
              <a
                href="mailto:abuse@desohosting.com"
                className="break-all text-[var(--accent)] hover:underline"
              >
                abuse@desohosting.com
              </a>
            </li>
          </ul>
        </section>
      </div>

      <p className="mt-12 border-t border-[var(--card-border)] pt-8 text-center text-sm text-[var(--muted)]">
        <Link href="/services" className="text-[var(--accent)] hover:underline">
          View VPS plans
        </Link>
      </p>
    </div>
  );
}
