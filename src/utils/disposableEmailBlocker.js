/**
 * Disposable & Temporary Email Domain Detection
 * Prevents automated bot registrations and short-lived junk accounts.
 */

const DISPOSABLE_DOMAINS = new Set([
  // Popular temporary email services
  "mailinator.com",
  "mailinator2.com",
  "mailin8r.com",
  "mailinator.net",
  "suremail.info",
  "safetymail.info",
  "guerrillamail.com",
  "guerrillamailblock.com",
  "guerrillamail.net",
  "guerrillamail.biz",
  "guerrillamail.org",
  "guerrillamail.de",
  "sharklasers.com",
  "grr.la",
  "spam4.me",
  "pokemail.net",
  "tempmail.com",
  "temp-mail.org",
  "temp-mail.io",
  "tempmailaddress.com",
  "10minutemail.com",
  "10minutemail.net",
  "10minutemail.org",
  "10minutemail.co.uk",
  "10minutemail.de",
  "minutemailbox.com",
  "throwawaymail.com",
  "throwaway.email",
  "yopmail.com",
  "yopmail.fr",
  "yopmail.net",
  "cool.fr.nf",
  "jetable.fr.nf",
  "nospam.ze.tc",
  "nomail.xl.cx",
  "mega.zik.dj",
  "speed.1s.fr",
  "courriel.fr.nf",
  "moncourrier.fr.nf",
  "monemail.fr.nf",
  "monmail.fr.nf",
  "trashmail.com",
  "trashmail.net",
  "trashmail.me",
  "trashmail.org",
  "rcpt.at",
  "damnthespam.com",
  "dispostable.com",
  "getairmail.com",
  "getairmail.net",
  "fakeinbox.com",
  "fakemailgenerator.com",
  "burnermail.io",
  "nada.ltd",
  "getnada.com",
  "mohmal.com",
  "dropmail.me",
  "mytemp.email",
  "crazymailing.com",
  "mailcatch.com",
  "inboxkitten.com",
  "emailondeck.com",
  "mytempemail.com",
  "trash-mail.com",
  "tempr.email",
  "discard.email",
  "discardmail.com",
  "spambog.com",
  "spambog.de",
  "spambog.ru",
  "armyspy.com",
  "cuvox.de",
  "dayrep.com",
  "fleckens.hu",
  "gustr.com",
  "jourrapide.com",
  "rhyta.com",
  "superrito.com",
  "teleworm.us",
  "einrot.com",
  "generator.email",
  "generator-email.com",
  "tempail.com",
  "disposablemail.com",
  "disposable-email.ml",
  "tempinbox.com",
  "anonymousemail.me",
  "zillamail.com",
  "binkmail.com",
  "bobmail.info",
  "chammy.info",
  "devnullmail.com",
  "letthemeatspam.com",
  "notmailinator.com",
  "reallymymail.com",
  "recognizethismail.com",
  "sendspamhere.com",
  "serty.org",
  "spambooger.com",
  "spamherelots.com",
  "spamhereplease.com",
  "trspam.com",
  "velmi.org",
]);

/**
 * Checks whether an email address uses a known disposable/temporary email provider.
 * @param {string} email
 * @returns {{ isDisposable: boolean, domain: string }}
 */
export function checkDisposableEmail(email) {
  if (!email || typeof email !== "string") {
    return { isDisposable: false, domain: "" };
  }

  const parts = email.toLowerCase().trim().split("@");
  if (parts.length !== 2) {
    return { isDisposable: false, domain: "" };
  }

  const domain = parts[1].trim();

  // Direct match
  if (DISPOSABLE_DOMAINS.has(domain)) {
    return { isDisposable: true, domain };
  }

  // Check subdomains (e.g. abc.mailinator.com)
  const domainParts = domain.split(".");
  if (domainParts.length > 2) {
    const rootDomain = domainParts.slice(-2).join(".");
    if (DISPOSABLE_DOMAINS.has(rootDomain)) {
      return { isDisposable: true, domain };
    }
  }

  return { isDisposable: false, domain };
}
