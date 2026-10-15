import type { NormalizedMessage, AttachmentMeta } from "../../src/types.js";

/**
 * LONG BUSINESS MAIL THAT MUST READ ORDINARY — tax returns and tax office letters, invoices and
 * reminders, contracts, bank and insurance letters, payslips, notary and fiduciary letters, in
 * de/en/fr/it. Every document carries the words a code classifier keys on (Code, PIN, Kennwort,
 * Zugangscode, "bestätigen Sie Ihre", "security code", "codice di accesso", …) and the numbers
 * business mail is full of (IBAN, AHV, Steuernummer, 6-digit customer numbers, dates), but none
 * carries a credential VALUE. Synthetic: every name, number and address is invented.
 */

export type BusinessCategory = "tax" | "invoice" | "contract" | "bank" | "insurance" | "payroll" | "notary";

export interface BusinessCase {
  id: string;
  lang: "de" | "en" | "fr" | "it";
  category: BusinessCategory;
  subject: string;
  text: string;
  /** Also send an HTML alternative rendered from the same paragraphs. */
  html?: boolean;
  attachments?: string[];
}

const pdf = (filename: string): AttachmentMeta =>
  ({ filename, contentType: "application/pdf", sizeBytes: 184_320, partId: "2", contentId: null, inline: false,
    contentSha256: "0".repeat(64) });

const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The same paragraphs as HTML, the way a mail client's rich editor sends them. */
function asHtml(text: string): string {
  const paras = text.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`);
  return `<html><body style="font-family:Arial">${paras.join("\n")}</body></html>`;
}

export function businessMessage(c: BusinessCase, textOverride?: string): NormalizedMessage {
  const text = textOverride ?? c.text;
  const attachments = (c.attachments ?? []).map(pdf);
  return {
    canonical: { messageIdHeader: null, bodyHash: "x" },
    subject: c.subject, from: { name: null, address: "office@example.invalid" }, to: [], cc: [],
    date: null, headers: {}, textBody: text, htmlBody: c.html ? asHtml(text) : null,
    hasAttachments: attachments.length > 0, attachments,
  };
}

const doc = (...paras: string[]): string => paras.join("\n\n");

export const BUSINESS_CORPUS: BusinessCase[] = [
  // ══ tax returns and tax office letters ═══════════════════════════════════════════════════
  {
    id: "de/tax fiduciary return for review", lang: "de", category: "tax", html: true,
    subject: "Steuererklärung 2025 – zur Prüfung",
    attachments: ["Steuererklaerung_2025_Entwurf.pdf", "Wertschriftenverzeichnis_2025.pdf"],
    text: doc(
      "Guten Tag Herr Keller",
      "Wie besprochen erhalten Sie beiliegend den Entwurf Ihrer Steuererklärung 2025 zur Prüfung. Wir haben die Unterlagen, die Sie uns im Februar zugestellt haben, vollständig erfasst und die Abzüge nach der aktuellen Praxis des Kantonalen Steueramts Zürich geltend gemacht.",
      "Bitte prüfen Sie insbesondere die folgenden Punkte:",
      "1. Personalien und Steuernummer: Die Steuernummer 1-234-567-89 und Ihre AHV-Nummer 756.1234.5678.97 haben wir aus der Veranlagung 2024 übernommen.\n"
        + "2. Wertschriftenverzeichnis: Das Konto bei der Kantonalbank (IBAN CH93 0076 2011 6238 5295 7) weist per 31.12.2025 einen Saldo von CHF 48 213.40 aus. Die Zinsgutschrift von CHF 129.90 ist deklariert.\n"
        + "3. Säule 3a: Die Bestätigung der Einzahlung über CHF 7 258.00 liegt vor und ist unter Ziffer 13.2 abgezogen.\n"
        + "4. Berufskosten: Für den Arbeitsweg haben wir die Pauschale für 220 Arbeitstage eingesetzt. Bitte bestätigen Sie Ihre Angaben zu den auswärtigen Verpflegungen.\n"
        + "5. Liegenschaft: Der Eigenmietwert gemäss Schätzung vom 14.05.2021 beträgt CHF 18 400.00, die Unterhaltskosten werden pauschal abgezogen.",
      "Den Zugangscode für die elektronische Einreichung finden Sie wie jedes Jahr auf dem Deckblatt der Steuererklärung, die Ihnen das Steueramt zugestellt hat. Sobald Sie uns die Freigabe erteilen, reichen wir die Erklärung für Sie ein. Die Frist läuft bis zum 30. September 2026; eine weitere Fristerstreckung ist nicht nötig.",
      "Das Kennwort für die verschlüsselte PDF-Datei senden wir Ihnen wie gewohnt per SMS an die hinterlegte Mobilnummer.",
      "Unsere Referenz: 2025-117 / MK. Für Rückfragen stehe ich Ihnen gerne zur Verfügung.",
      "Freundliche Grüsse\n\nMonika Brunner\nBrunner Treuhand AG\nBahnhofstrasse 12, 8001 Zürich\nTelefon 044 512 88 90",
    ),
  },
  {
    id: "de/tax assessment from the tax office", lang: "de", category: "tax",
    subject: "Kantonales Steueramt: Veranlagungsverfügung Staats- und Gemeindesteuern 2024",
    text: doc(
      "Sehr geehrte Frau Meier",
      "Wir stellen Ihnen die Veranlagungsverfügung für die Staats- und Gemeindesteuern 2024 zu. Die Veranlagung weicht in zwei Punkten von Ihrer Steuererklärung ab:",
      "- Die Kosten für die Weiterbildung wurden nur im Umfang von CHF 3 200.00 anerkannt, da die restlichen Auslagen einen Wechsel des Berufs betreffen.\n"
        + "- Der Abzug für die Kinderbetreuung durch Dritte wurde gemäss Beleg auf CHF 10 100.00 begrenzt.",
      "Das steuerbare Einkommen beträgt CHF 94 300.00, das steuerbare Vermögen CHF 212 000.00. Die provisorische Rechnung vom 15.03.2025 wird mit der Schlussrechnung verrechnet; der Restbetrag von CHF 1 482.35 ist innert 30 Tagen zahlbar. Bitte verwenden Sie für die Zahlung die QR-Rechnung mit der Referenz 21 00000 00003 13947 14300 09017.",
      "Gegen diese Verfügung können Sie innert 30 Tagen nach Zustellung schriftlich Einsprache erheben. Die Einsprache ist zu begründen und allfällige Beweismittel sind beizulegen.",
      "Für die Steuererklärung 2025 erhalten Sie im Februar wie gewohnt die Unterlagen mit einem neuen Zugangscode für die elektronische Einreichung. Den bisherigen Code können Sie nicht mehr verwenden. Wenn Sie die Erklärung elektronisch einreichen, erhalten Sie nach der Übermittlung eine Bestätigung mit dem Datum des Eingangs.",
      "Diese Mitteilung wurde elektronisch erstellt und ist ohne Unterschrift gültig.",
      "Kantonales Steueramt\nDienstabteilung Veranlagung\nBändliweg 21, 8090 Zürich\nGemeinde-Nr. 261 · Register-Nr. 482913 · Dossier 2024/0815",
    ),
  },
  {
    id: "en/tax accountant return for review", lang: "en", category: "tax", html: true,
    subject: "Your 2025 tax return – draft for review",
    attachments: ["SA100_2025_draft.pdf"],
    text: doc(
      "Dear Mr Patel,",
      "Please find attached the draft of your Self Assessment tax return for the year ended 5 April 2025, together with our computation of the tax due. We would be grateful if you could review it carefully before we submit it to HM Revenue & Customs.",
      "Summary of the figures:",
      "Employment income (P" + "60 from Harrow Logistics Ltd): £58,240.00\nTax deducted under PAYE: £9,861.20\nProperty income (net, after allowable expenses): £7,415.00\nBank interest (account ending 4829): £312.66\nGift Aid donations: £450.00",
      "Based on these figures, the balance due for 2024/25 is £1,482.35, and a first payment on account of £741.18 will fall due on 31 January 2026. Your Unique Taxpayer Reference is 12345 67890 and your National Insurance number is QQ 12 34 56 C; please check that both are correct.",
      "As in previous years, HMRC will write to you separately with an access code for your online tax account. We do not need it and you should keep it to yourself. If you prefer to authorise us as your ag" + "ent, please confirm your address and date of birth in your reply so that we can complete the authorisation request.",
      "Please could you also confirm the following:\n1. whether you received any other income, such as dividends or foreign pensions;\n2. whether the rental property was available for letting for the whole year;\n3. the reference 482913 on the letting ag" + "ent's annual statement, which we need for our file.",
      "Once you have approved the return, we will file it online and send you the submission receipt for your records. The deadline for online filing is 31 January 2026.",
      "Kind regards,\n\nSarah Whitfield ACA\nWhitfield & Partners Chartered Accountants\n14 Market Street, Reading RG1 2AB",
    ),
  },
  {
    id: "fr/tax fiduciary return for review", lang: "fr", category: "tax", html: true,
    subject: "Déclaration d'impôt 2025 – projet pour contrôle",
    attachments: ["Declaration_2025_projet.pdf"],
    text: doc(
      "Madame Rochat,",
      "Nous vous transmettons en annexe le projet de votre déclaration d'impôt 2025, établi sur la base des documents que vous nous avez remis en février. Nous vous remercions de bien vouloir le contrôler avant que nous le déposions auprès de l'Administration cantonale des impôts.",
      "Points à vérifier en priorité :",
      "1. Données personnelles : votre numéro de contribuable 482 913 017 et votre numéro AVS 756.9876.5432.10 ont été repris de la taxation 2024.\n"
        + "2. Revenus : le certificat de salaire de votre employeur indique un salaire net de CHF 86 450.00. Les frais de déplacement ont été calculés pour 215 jours de travail.\n"
        + "3. Fortune : le relevé fiscal de votre banque (IBAN CH44 0076 7000 S" + "123 4567 8) affiche un solde de CHF 36 918.25 au 31 décembre 2025.\n"
        + "4. Pilier 3a : l'attestation de versement de CHF 7 258.00 figure sous le code 3.1 du formulaire.",
      "Comme chaque année, l'administration vous a adressé par courrier un code d'accès pour la déclaration en ligne. Nous n'en avons pas besoin : il vous suffit de nous confirmer votre accord par retour de courriel. Confirmez votre présence au rendez-vous du 12 mars à 10 h 00 si vous souhaitez passer en revue le projet avec nous.",
      "Le mot de passe du fichier PDF vous parviendra séparément par SMS. Nous vous rappelons que le délai de dépôt est fixé au 15 mars 2026 ; une prolongation peut être demandée en ligne.",
      "Notre référence : 2025-048 / CR. Nous restons à votre disposition pour toute question.",
      "Meilleures salutations,\n\nClaire Rochat-Dubois\nFiduciaire Léman SA\nAvenue de la Gare 7, 1003 Lausanne",
    ),
  },
  {
    id: "it/tax fiduciary return for review", lang: "it", category: "tax", html: true,
    subject: "Dichiarazione d'imposta 2025 – bozza da verificare",
    attachments: ["Dichiarazione_2025_bozza.pdf"],
    text: doc(
      "Gentile signor Bernasconi,",
      "in allegato le trasmettiamo la bozza della sua dichiarazione d'imposta 2025, allestita sulla base dei documenti ricevuti a febbraio. La preghiamo di verificarla con attenzione prima che la inoltriamo alla Divisione delle contribuzioni.",
      "Punti da controllare:",
      "1. Dati personali: il numero di contribuente 1234567 e il numero AVS 756.1111.2222.33 sono stati ripresi dalla tassazione 2024. Per i redditi italiani abbiamo indicato anche il suo codice fiscale BRNMRC72A01H501Z.\n"
        + "2. Redditi: il certificato di salario indica un reddito netto di CHF 91 870.00; le spese di trasferta sono calcolate su 218 giorni lavorativi.\n"
        + "3. Sostanza: l'estratto fiscale della banca (IBAN CH12 0076 4123 4567 8901 2) riporta un saldo di CHF 22 413.60 al 31 dicembre 2025.\n"
        + "4. Terzo pilastro: la conferma del versamento di CHF 7 258.00 è allegata.",
      "Come ogni anno, la Divisione le ha inviato per posta il codice di accesso per la dichiarazione online. Non ci serve: è sufficiente che lei ci confermi il suo accordo rispondendo a questa email. Se desidera discutere la bozza, il nostro portale clienti le ha inviato l'invito «Conferma il tuo appuntamento del 14 marzo».",
      "La password del file PDF le verrà comunicata separatamente per SMS. Il termine per l'inoltro è il 30 aprile 2026.",
      "In una parola, manca soltanto la sua approvazione. Il nostro riferimento: 2025-091 / GB.",
      "Cordiali saluti\n\nGiulia Bernasconi\nFiduciaria Ceresio SA\nVia Nassa 5, 6900 Lugano",
    ),
  },

  // ══ invoices and payment reminders ═══════════════════════════════════════════════════════
  {
    id: "de/invoice payment reminder", lang: "de", category: "invoice",
    subject: "Zahlungserinnerung Rechnung 100245",
    attachments: ["Rechnung_100245_QR.pdf"],
    text: doc(
      "Sehr geehrte Damen und Herren",
      "Bei der Kontrolle unserer Buchhaltung haben wir festgestellt, dass die folgende Rechnung noch offen ist:",
      "Rechnung Nr. 100245 vom 12.02.2026, fällig am 14.03.2026, Betrag CHF 2 418.60\nKundennummer: 482913\nIhre Bestellung: 4500018273 vom 03.02.2026",
      "Möglicherweise hat sich Ihre Zahlung mit diesem Schreiben gekreuzt. In diesem Fall betrachten Sie diese Erinnerung bitte als gegenstandslos. Andernfalls bitten wir Sie, den offenen Betrag innert 10 Tagen auf unser Konto zu überweisen:",
      "IBAN CH44 3199 9123 0008 8901 2, lautend auf Keller Haustechnik GmbH, Winterthur\nQR-Referenz: 21 00000 00003 13947 14300 09017",
      "Bitte verwenden Sie für die Zahlung unbedingt die QR-Rechnung im Anhang oder geben Sie die Referenz vollständig an, damit wir Ihre Zahlung korrekt zuordnen können. Eine Bestätigung des Zahlungseingangs senden wir Ihnen auf Wunsch gerne zu.",
      "Wenn Sie Ihre Rechnungen künftig im Kundenportal einsehen möchten: Die Zugangsdaten erhalten Sie per Post, und Ihr Passwort ändern können Sie jederzeit unter Einstellungen. Den PIN für die Türanlage im Lager Hegi erhalten Sie weiterhin vom Hauswart.",
      "Bei Fragen zur Rechnung erreichen Sie unsere Buchhaltung unter 052 213 44 90 (Montag bis Freitag, 08.00–12.00 Uhr).",
      "Freundliche Grüsse\n\nKeller Haustechnik GmbH\nBuchhaltung\nIndustriestrasse 41, 8404 Winterthur\nMWST-Nr. CHE-123.456.789 MWST",
    ),
  },
  {
    id: "en/invoice payment reminder", lang: "en", category: "invoice", html: true,
    subject: "Payment reminder – invoice INV-20" + "26-0412",
    text: doc(
      "Dear Accounts Payable team,",
      "Our records show that the following invoice remains unpaid:",
      "Invoice number: INV-20" + "26-0412\nInvoice date: 3 February 2026\nDue date: 5 March 2026\nAmount due: EUR 4,827.50\nPurchase order: 482913\nCustomer account: 100245",
      "We appreciate that payments sometimes cross in the post. If you have already settled this invoice, please accept our thanks and disregard this reminder. Otherwise, we would be grateful if you could arrange payment within the next ten days to the account below:",
      "Bank: Handelsbank AG, Frankfurt\nIBAN: DE89 3704 0044 0532 0130 00\nBIC: COBADEFFXXX\nPayment reference: INV-20" + "26-0412",
      "Please quote the invoice number as the payment reference so that our system can match your remittance automatically. If you pay by card through our billing portal, the portal will ask for your card's security code; we never ask for it by email or phone.",
      "To view statements online, use your account number and password to log in to the billing portal. If you need to confirm your account details or change the invoicing address, reply to this email and our credit control team will update our records within two working days.",
      "A late payment fee may be applied to invoices more than 30 days overdue, in line with our standard terms and conditions of sale.",
      "Kind regards,\n\nCredit Control\nNorthbridge Components Ltd\nUnit 4, Riverside Park, Leeds LS10 1AB\nCompany number 04827351 · VAT GB 123 4567 89",
    ),
  },
  {
    id: "fr/invoice payment reminder", lang: "fr", category: "invoice",
    subject: "Rappel de paiement – facture 2026-0412",
    text: doc(
      "Madame, Monsieur,",
      "Sauf erreur de notre part, la facture suivante n'a pas encore été réglée :",
      "Facture n° 2026-0412 du 3 février 2026\nÉchéance : 5 mars 2026\nMontant : CHF 1 874.35\nNuméro de client : 482913",
      "Il est possible que votre paiement se soit croisé avec ce courrier ; dans ce cas, nous vous prions de ne pas tenir compte de ce rappel. Dans le cas contraire, nous vous remercions de bien vouloir effectuer le versement dans un délai de dix jours sur le compte suivant :",
      "IBAN CH51 0078 8000 0501 2345 6\nRéférence QR : 21 00000 00003 13947 14300 09017",
      "Si vous réglez par carte sur notre portail, le code de sécurité de votre carte vous sera demandé à l'étape du paiement ; nous ne vous le demanderons jamais par courriel. Pour consulter vos factures en ligne, vous pouvez modifier votre mot de passe à tout moment dans l'espace client. Confirmez votre adresse de facturation si elle a changé depuis votre dernière commande.",
      "Des frais de rappel de CHF 20.00 pourront être facturés à partir du deuxième rappel, conformément à nos conditions générales de vente.",
      "Avec nos meilleures salutations,\n\nService de comptabilité\nImprimerie du Rhône SA\nRue des Deux-Ponts 14, 1205 Genève\nIDE CHE-482.913.017 TVA",
    ),
  },
  {
    id: "it/invoice payment reminder", lang: "it", category: "invoice", html: true,
    subject: "Sollecito di pagamento – fattura 2026-0412",
    text: doc(
      "Gentili signore e signori,",
      "dai nostri controlli risulta che la seguente fattura non è ancora stata saldata:",
      "Fattura n. 2026-0412 del 3 febbraio 2026\nScadenza: 5 marzo 2026\nImporto: CHF 3 412.80\nCodice cliente: 482913",
      "Se nel frattempo avete già effettuato il pagamento, vi preghiamo di considerare nullo il presente sollecito. In caso contrario vi chiediamo di versare l'importo entro dieci giorni sul seguente conto:",
      "IBAN CH93 8080 8001 2345 6789 0\nRiferimento QR: 21 00000 00003 13947 14300 09017",
      "Per il pagamento con carta sul nostro portale vi verrà chiesto il codice di sicurezza della carta; non ve lo chiederemo mai per email o per telefono. Nell'area clienti potete consultare le fatture e modificare la password in qualsiasi momento. Vi ricordiamo inoltre che il PIN della vostra tessera fedeltà non è mai necessario per i pagamenti.",
      "A partire dal secondo sollecito potranno essere addebitate spese di CHF 20.00, conformemente alle nostre condizioni generali.",
      "Distinti saluti\n\nContabilità\nTipografia Ticinese SA\nVia Cantonale 18, 6814 Lamone\nIDI CHE-482.913.017 IVA",
    ),
  },

  // ══ contracts ════════════════════════════════════════════════════════════════════════════
  {
    id: "de/contract commercial lease", lang: "de", category: "contract",
    subject: "Mietvertrag Geschäftsräume – Unterlagen zur Unterzeichnung",
    attachments: ["Mietvertrag_Seestrasse_88.pdf"],
    text: doc(
      "Sehr geehrter Herr Frei",
      "Im Anhang erhalten Sie den Mietvertrag für die Geschäftsräume an der Seestrasse 88 in Horgen zur Unterzeichnung. Die wichtigsten Eckpunkte fassen wir hier nochmals zusammen:",
      "- Mietobjekt: Büro im 2. Obergeschoss, 184 m², inkl. zwei Parkplätze in der Einstellhalle\n- Mietbeginn: 1. Juni 2026, feste Mietdauer bis 31. Mai 2031 mit Verlängerungsoption um fünf Jahre\n- Nettomiete: CHF 4 820.00 pro Monat, Nebenkostenakonto CHF 610.00\n- Mietzinsdepot: drei Monatsmieten, einzuzahlen auf ein Sperrkonto\n- Vertragsnummer: 2026-0418, Objekt-Nr. 482913",
      "Bitte bestätigen Sie Ihre Zustimmung zu den besprochenen Anpassungen in Ziffer 7 (Ausbau der Teeküche) und Ziffer 11 (Untervermietung an verbundene Gesellschaften), bevor Sie den Vertrag unterzeichnen. Die Anpassungen sind im Dokument gelb markiert.",
      "Bei der Schlüsselübergabe am 29. Mai erhalten Sie die Badges für die Zutrittskontrolle. Den Zugangscode für das Haupttor teilt Ihnen der Hauswart bei der Übergabe persönlich mit; er wird aus Sicherheitsgründen nicht per E-Mail versandt.",
      "Die neue Anmeldung Ihrer Firma beim Handelsregister mit der geänderten Geschäftsadresse übernimmt Ihr Treuhänder. Bitte senden Sie uns zwei unterzeichnete Exemplare bis zum 15. April 2026 zurück; ein gegengezeichnetes Exemplar erhalten Sie anschliessend von uns.",
      "Für Fragen stehe ich Ihnen gerne zur Verfügung.",
      "Freundliche Grüsse\n\nDaniel Suter\nSuter Immobilien AG\nDorfstrasse 3, 8810 Horgen",
    ),
  },
  {
    id: "en/contract master services agreement", lang: "en", category: "contract", html: true,
    subject: "Master Services Agreement – execution version",
    attachments: ["MSA_execution_version.pdf"],
    text: doc(
      "Dear Ms Okafor,",
      "Further to our call on Tuesday, please find attached the execution version of the Master Services Agreement between Brightline Analytics Ltd and Harbour Freight plc, together with Schedules 1 to 4. We have incorporated the changes your legal team requested in their mark-up of 12 March:",
      "1. Clause 8.3 (Limitation of liability): the cap is now 150% of the fees paid in the preceding twelve months.\n2. Clause 12 (Data protection): the data processing addendum in Schedule 3 reflects the current standard contractual clauses.\n3. Clause 15.2 (Termination for convenience): the notice period has been extended from 60 to 90 days.\n4. Schedule 2 (Service levels): the availability target is 99.5% measured monthly, with service credits as set out in the table.",
      "The agreement will be signed electronically through our signing platform. You will receive a separate invitation to the signing envelope 482913; the platform may ask you to verify your identity with a message to your mobile phone before you can sign. Please do not forward the invitation, as it is personal to the named signatory.",
      "For the data room, the access code remains unchanged and your paralegal already has it. If anything in the attached version does not match your understanding, please let me know by Friday so that we can keep to the signing date of 31 March 2026.",
      "Once both parties have signed, the platform will email each signatory a completion certificate and a copy of the fully executed agreement for your records.",
      "Kind regards,\n\nJames Holloway\nSenior Legal Counsel\nBrightline Analytics Ltd\n22 Chancery Lane, London WC2A 1LS",
    ),
  },
  {
    id: "fr/contract commercial lease", lang: "fr", category: "contract",
    subject: "Contrat de bail commercial – version à signer",
    text: doc(
      "Monsieur Favre,",
      "Vous trouverez en annexe le contrat de bail commercial pour les locaux situés Rue du Marché 22 à Neuchâtel, dans la version qui tient compte de nos échanges de la semaine dernière. En voici les principaux éléments :",
      "- Objet : surface commerciale de 126 m² au rez-de-chaussée, avec vitrine et dépôt au sous-sol\n- Début du bail : 1er juillet 2026, durée initiale de cinq ans, renouvelable\n- Loyer net : CHF 3 150.00 par mois, acompte de charges CHF 380.00\n- Garantie de loyer : trois mois de loyer, à déposer sur un compte bloqué\n- Numéro de contrat : 2026-0233, référence de l'objet 482913",
      "Confirmez votre accord sur les modifications de l'article 6 (aménagements) et de l'article 9 (sous-location) avant de signer ; elles sont surlignées dans le document. Le code de confirmation de la plateforme de signature électronique vous sera envoyé par SMS au moment de la signature ; nous n'y avons pas accès.",
      "La remise des clés aura lieu le 30 juin à 9 h 00. Le code secret de l'alarme vous sera communiqué oralement par le concierge, jamais par courriel.",
      "Nous vous remercions de nous retourner le contrat signé d'ici au 20 avril 2026.",
      "Avec nos salutations distinguées,\n\nRégie du Littoral SA\nService location commerciale\nFaubourg du Lac 11, 2000 Neuchâtel",
    ),
  },
  {
    id: "it/contract commercial lease", lang: "it", category: "contract",
    subject: "Contratto di locazione commerciale – versione per la firma",
    text: doc(
      "Egregio signor Galli,",
      "le trasmettiamo in allegato il contratto di locazione per gli spazi commerciali in Via Lugano 14 a Bellinzona, nella versione che tiene conto dei punti discussi la settimana scorsa. Riepiloghiamo gli elementi principali:",
      "- Oggetto: negozio di 98 m² al piano terreno con magazzino al piano interrato\n- Inizio della locazione: 1° luglio 2026, durata iniziale di cinque anni, rinnovabile\n- Pigione netta: CHF 2 480.00 al mese, acconto spese CHF 290.00\n- Deposito di garanzia: tre mensilità su un conto bloccato\n- Numero di contratto: 2026-0377, riferimento dell'oggetto 482913",
      "La preghiamo di verificare in particolare l'articolo 5 (lavori di adattamento) e l'articolo 12 (sublocazione). Il codice di conferma per la firma elettronica le verrà inviato per SMS dalla piattaforma al momento della firma; noi non vi abbiamo accesso. Il codice di accesso al magazzino le sarà comunicato di persona dal custode alla consegna delle chiavi.",
      "La consegna delle chiavi è prevista per il 30 giugno alle ore 9.00. La preghiamo di rispedirci il contratto firmato entro il 20 aprile 2026.",
      "Distinti saluti\n\nAmministrazione Stabili Ticino SA\nUfficio locazioni commerciali\nViale Stazione 9, 6500 Bellinzona",
    ),
  },

  // ══ bank letters ═════════════════════════════════════════════════════════════════════════
  {
    id: "de/bank new debit card", lang: "de", category: "bank", html: true,
    subject: "Ihre neue Debitkarte und wichtige Informationen zu Ihrem Konto",
    text: doc(
      "Guten Tag Frau Huber",
      "Ihre bisherige Debitkarte läuft Ende April 2026 ab. Die neue Karte haben wir Ihnen heute an Ihre Adresse in 3011 Bern gesendet. Sie ist sofort nach Erhalt einsetzbar; Ihre bisherige PIN bleibt unverändert gültig. Falls Sie Ihre PIN vergessen haben, können Sie bei uns eine neue PIN bestellen; sie wird Ihnen aus Sicherheitsgründen mit separater Post zugestellt.",
      "Bitte beachten Sie:",
      "- Kontonummer: 16 482.913.07, IBAN CH56 0483 5012 3456 7800 9\n- Die Karte ist mit Ihrem Privatkonto verknüpft; die Limite beträgt CHF 5 000.00 pro Monat.\n- Den Sicherheitscode auf der Rückseite der Karte benötigen Sie nur für Zahlungen im Internet. Geben Sie ihn niemals am Telefon oder per E-Mail weiter.\n- Für Zahlungen im E-Banking verwenden Sie wie bisher die App zur Freigabe; eine TAN per SMS versenden wir nicht mehr.",
      "Zu unseren Gebühren: Ab dem 1. Juli 2026 beträgt die Jahresgebühr für die Debitkarte CHF 40.00. Die Kontoführung bleibt für Sie kostenlos, solange Ihr Lohn auf dieses Konto überwiesen wird.",
      "Wir weisen Sie darauf hin, dass wir Sie nie auffordern werden, Ihr Passwort, Ihre PIN oder einen Code per E-Mail anzugeben. Bei einer Anmeldung im E-Banking auf einem unbekannten Gerät erhalten Sie immer eine Benachrichtigung in der App.",
      "Bei Fragen erreichen Sie uns unter 031 482 91 30.",
      "Freundliche Grüsse\n\nBerner Regionalbank AG\nKundendienst Privatkunden\nBundesplatz 4, 3011 Bern",
    ),
  },
  {
    id: "en/bank new card and changed terms", lang: "en", category: "bank",
    subject: "Important changes to your account terms and your new card",
    text: doc(
      "Dear Mr Lindqvist,",
      "We are writing to let you know about changes to the terms of your Everyday Current Account, which take effect on 1 June 2026, and to confirm that your replacement debit card has been dispatched.",
      "Your account details:\nSort code: 40-11-62\nAccount number: 48291374\nCard ending: 5521",
      "What is changing:\n1. The arranged overdraft interest rate will change from 35.9% EAR to 34.9% EAR (variable).\n2. The monthly account fee of £3.00 will be waived if you pay in at least £1,000 each month.\n3. Cash withdrawals abroad will be charged at 2.99% of the amount withdrawn, with a minimum of £1.50.",
      "Your new card will arrive within five working days. Your PIN stays the same, so you do not need to wait for a PIN letter. If you have forgotten it, you can view your PIN in the mobile app or ask us to send a new one by post.",
      "Please remember that we will never ask you to share your PIN, your card's security code or any code we send you. If we need to verify your identity when you call us, we will ask you security questions that only you would know. If you notice any transaction you do not recognise, please call us immediately on 0345 482 9137.",
      "You do not need to do anything if you are happy with these changes. If you are not, you can close your account at any time before 1 June 2026 without charge. The full terms and our tariff of charges are enclosed.",
      "Yours sincerely,\n\nHelen Marsh\nHead of Customer Communications\nLakeland Savings Bank plc",
    ),
  },
  {
    id: "fr/bank new debit card", lang: "fr", category: "bank",
    subject: "Votre nouvelle carte de débit et les modifications de nos conditions",
    text: doc(
      "Madame Perret,",
      "Votre carte de débit actuelle arrive à échéance à la fin du mois d'avril 2026. Nous vous avons envoyé aujourd'hui votre nouvelle carte ; elle peut être utilisée dès réception. Votre code secret reste inchangé. Si vous l'avez oublié, vous pouvez commander un nouveau code, qui vous sera envoyé par courrier séparé pour des raisons de sécurité.",
      "Informations utiles :\n- Numéro de compte : 482.913-07, IBAN CH38 0076 8300 1234 5678 9\n- Limite de la carte : CHF 5 000.00 par mois\n- Le code de sécurité au dos de la carte n'est nécessaire que pour les paiements en ligne. Ne le communiquez jamais par téléphone ni par courriel.",
      "À partir du 1er juillet 2026, la cotisation annuelle de la carte s'élèvera à CHF 40.00. La tenue de compte reste gratuite tant que votre salaire est versé sur ce compte.",
      "Nous ne vous demanderons jamais votre mot de passe, votre code secret ou un code reçu par SMS. Pour toute nouvelle connexion à l'e-banking depuis un appareil inconnu, une notification vous est envoyée dans l'application.",
      "Pour toute question, notre service clientèle est à votre disposition au 021 482 91 30.",
      "Meilleures salutations,\n\nBanque Régionale du Jura SA\nService clientèle\nRue de la Préfecture 8, 2800 Delémont",
    ),
  },
  {
    id: "it/bank new debit card", lang: "it", category: "bank", html: true,
    subject: "La sua nuova carta di debito e le modifiche alle condizioni",
    text: doc(
      "Gentile signora Rossi,",
      "la sua carta di debito attuale scade alla fine di aprile 2026. Oggi le abbiamo inviato la nuova carta, utilizzabile subito dopo la ricezione. Il suo PIN resta invariato; se lo ha dimenticato, può ordinare un nuovo PIN, che per motivi di sicurezza le verrà inviato per posta separata.",
      "Informazioni utili:\n- Numero di conto: 482.913-07, IBAN CH71 0076 4300 1234 5678 9\n- Limite della carta: CHF 5 000.00 al mese\n- Il codice di sicurezza sul retro della carta serve solo per i pagamenti online. Non lo comunichi mai per telefono o per email.",
      "Dal 1° luglio 2026 la tassa annuale della carta sarà di CHF 40.00. La tenuta del conto resta gratuita finché il suo stipendio viene accreditato su questo conto.",
      "Non le chiederemo mai la password, il PIN o un codice ricevuto per SMS. In caso di nuovo accesso all'e-banking da un dispositivo sconosciuto riceverà sempre una notifica nell'app.",
      "Per qualsiasi domanda il nostro servizio clienti è a sua disposizione al numero 091 482 91 30.",
      "Cordiali saluti\n\nBanca Regionale Ticinese SA\nServizio clienti\nPiazza Indipendenza 2, 6500 Bellinzona",
    ),
  },

  // ══ insurance letters ════════════════════════════════════════════════════════════════════
  {
    id: "de/insurance household policy", lang: "de", category: "insurance",
    subject: "Ihre Police Hausrat- und Privathaftpflichtversicherung 2026",
    attachments: ["Police_48291374.pdf", "Praemienrechnung_2026.pdf"],
    text: doc(
      "Sehr geehrter Herr Baumann",
      "Wir danken Ihnen für Ihr Vertrauen. Im Anhang finden Sie Ihre neue Police für die Hausrat- und Privathaftpflichtversicherung, gültig ab 1. Januar 2026.",
      "Ihre Versicherungsdaten:\n- Policennummer: 48.291.374\n- Kundennummer: 100245\n- Versicherungssumme Hausrat: CHF 120 000.00 (Neuwert)\n- Selbstbehalt: CHF 200.00 pro Schadenfall\n- Jahresprämie: CHF 486.30, fällig am 31.01.2026",
      "Neu ist auch der Diebstahl auswärts bis CHF 5 000.00 mitversichert. Für Ihr neues Gerät, das Sie uns im Dezember gemeldet haben, gilt der Zusatz «Elektronik Plus» ab dem Kaufdatum.",
      "Bitte bestätigen Sie Ihre Angaben zur Wohnfläche und zur Anzahl Personen im Haushalt bis zum 15. Februar 2026, damit wir die Prämie korrekt berechnen können. Sie können dies bequem im Kundenportal erledigen; bei der ersten Anmeldung erhalten Sie dort einen Bestätigungscode per SMS, den Sie im Portal eingeben.",
      "Im Schadenfall erreichen Sie uns rund um die Uhr unter 0800 482 913. Bitte halten Sie Ihre Policennummer bereit.",
      "Die Prämienrechnung mit QR-Zahlteil liegt dieser E-Mail ebenfalls bei. Die Allgemeinen Versicherungsbedingungen (Ausgabe 2026) finden Sie auf unserer Website.",
      "Freundliche Grüsse\n\nAare Versicherungen AG\nKundendienst Region Mittelland\nLaupenstrasse 27, 3008 Bern",
    ),
  },
  {
    id: "en/insurance motor renewal", lang: "en", category: "insurance", html: true,
    subject: "Your motor insurance renewal – policy MTR-4829137",
    text: doc(
      "Dear Ms Adeyemi,",
      "Your motor insurance policy is due for renewal on 1 May 2026. We have enclosed your renewal documents, including your new certificate of insurance and a summary of your cover.",
      "Policy number: MTR-4829137\nVehicle: 2021 hatchback, registration AB21 CDE\nAnnual premium: £612.40 (last year £588.10)\nVoluntary excess: £250.00; compulsory excess: £150.00",
      "Why your premium has changed: repair costs and the price of replacement parts have risen across the market, and your no-claims discount has increased to seven years, which partly offsets this.",
      "Changes to your cover this year:\n- New device cover: phones and tablets left in the car are now covered up to £500 if the car is broken into.\n- Courtesy car: a small courtesy car is provided while your car is repaired by one of our approved repairers.",
      "If you pay by monthly direct debit, the first instalment of £53.12 will be collected on or around 1 May. To make a change, please confirm your address and annual mileage by replying to this email or through your online account. If you have lost your login details, you can request a password reset from the sign-in page.",
      "Please check your documents carefully and tell us if anything is incorrect. Giving us incorrect information could invalidate your policy.",
      "Yours sincerely,\n\nRenewals Team\nKestrel Direct Insurance\nPO Box 4829, Bristol BS1 6AA",
    ),
  },
  {
    id: "fr/insurance household policy", lang: "fr", category: "insurance",
    subject: "Votre police d'assurance ménage et responsabilité civile 2026",
    text: doc(
      "Monsieur Girard,",
      "Nous vous remercions de votre confiance. Vous trouverez en annexe votre nouvelle police d'assurance ménage et responsabilité civile, valable dès le 1er janvier 2026.",
      "Vos données :\n- Numéro de police : 48.291.374\n- Numéro de client : 100245\n- Somme d'assurance ménage : CHF 90 000.00 (valeur à neuf)\n- Franchise : CHF 200.00 par sinistre\n- Prime annuelle : CHF 412.70, échéance le 31.01.2026",
      "Le vol hors du domicile est désormais couvert jusqu'à CHF 5 000.00. Pour le nouvel appareil que vous nous avez annoncé en décembre, l'option « Électronique Plus » s'applique dès la date d'achat.",
      "Confirmez votre surface habitable et le nombre de personnes vivant dans le ménage d'ici au 15 février 2026, afin que nous puissions calculer correctement la prime. Vous pouvez le faire dans l'espace client ; lors de la première connexion, un code de vérification vous sera envoyé par SMS.",
      "En cas de sinistre, vous pouvez nous joindre 24 heures sur 24 au 0800 482 913. Veuillez garder votre numéro de police à portée de main.",
      "La facture de prime avec la section de paiement QR est jointe à ce courriel. Les conditions générales (édition 2026) sont disponibles sur notre site.",
      "Avec nos meilleures salutations,\n\nAssurances du Léman SA\nService clientèle Suisse romande\nAvenue de Rumine 20, 1005 Lausanne",
    ),
  },
  {
    id: "it/insurance household policy", lang: "it", category: "insurance",
    subject: "La sua polizza economia domestica e responsabilità civile 2026",
    text: doc(
      "Gentile signor Ferrari,",
      "la ringraziamo per la fiducia. In allegato trova la nuova polizza di assicurazione economia domestica e responsabilità civile, valida dal 1° gennaio 2026.",
      "I suoi dati:\n- Numero di polizza: 48.291.374\n- Numero cliente: 100245\n- Somma assicurata economia domestica: CHF 80 000.00 (valore a nuovo)\n- Franchigia: CHF 200.00 per sinistro\n- Premio annuo: CHF 398.90, scadenza 31.01.2026",
      "Il furto fuori casa è ora coperto fino a CHF 5 000.00. Per il nuovo apparecchio che ci ha segnalato a dicembre vale l'opzione «Elettronica Plus» dalla data d'acquisto.",
      "La preghiamo di confermare la superficie abitabile e il numero di persone nell'economia domestica entro il 15 febbraio 2026. Può farlo nell'area clienti: al primo accesso riceverà per SMS un codice di verifica da inserire nel portale.",
      "In caso di sinistro ci può raggiungere 24 ore su 24 al numero 0800 482 913. Tenga a portata di mano il numero di polizza.",
      "La fattura del premio con la sezione di pagamento QR è allegata a questa email. Le condizioni generali (edizione 2026) sono disponibili sul nostro sito.",
      "Cordiali saluti\n\nAssicurazioni della Svizzera Italiana SA\nServizio clienti\nCorso Elvezia 10, 6900 Lugano",
    ),
  },

  // ══ payroll slips ════════════════════════════════════════════════════════════════════════
  {
    id: "de/payroll monthly payslip", lang: "de", category: "payroll",
    subject: "Lohnabrechnung März 2026",
    attachments: ["Lohnabrechnung_2026-03.pdf"],
    text: doc(
      "Guten Tag Frau Schmid",
      "Im Anhang finden Sie Ihre Lohnabrechnung für den Monat März 2026. Die Auszahlung erfolgt am 25. März 2026 auf Ihr Konto mit der IBAN CH93 0076 2011 6238 5295 7.",
      "Übersicht:\n- Bruttolohn: CHF 7 850.00\n- AHV/IV/EO (5,3 %): CHF 416.05\n- ALV (1,1 %): CHF 86.35\n- Pensionskasse: CHF 512.40\n- Quellensteuer: entfällt\n- Nettolohn: CHF 6 835.20",
      "Ihre Personalnummer lautet 482913, Ihre AHV-Nummer 756.1234.5678.97. Bitte prüfen Sie die Angaben und melden Sie Abweichungen bis zum Monatsende der Personalabteilung.",
      "Ab April erhalten Sie Ihre Lohnabrechnungen nur noch im Mitarbeiterportal. Für die erste Anmeldung verwenden Sie Ihre Personalnummer und das Kennwort, das Ihnen die Personalabteilung separat per Post zustellt. Nach der ersten Anmeldung werden Sie aufgefordert, Ihr Passwort zu ändern. Bitte bestätigen Sie Ihre private Adresse im Portal, damit der Lohnausweis 2026 korrekt zugestellt werden kann.",
      "Die neue Anmeldung bei der Pensionskasse nach Ihrer Pensumserhöhung ist erfolgt; die angepassten Beiträge sind in dieser Abrechnung bereits berücksichtigt.",
      "Bei Fragen wenden Sie sich bitte an Petra Meier, Personaladministration, Telefon 044 482 91 37.",
      "Freundliche Grüsse\n\nPersonalabteilung\nLimmat Logistik AG\nHardturmstrasse 120, 8005 Zürich",
    ),
  },
  {
    id: "en/payroll monthly payslip", lang: "en", category: "payroll", html: true,
    subject: "Your March 2026 payslip",
    attachments: ["Payslip_2026-03.pdf"],
    text: doc(
      "Hi Tom,",
      "Your payslip for March 2026 is attached. Your net pay of £3,412.58 will be paid into your bank account ending 7731 on 27 March.",
      "Summary:\nGross pay: £4,750.00\nIncome tax (tax code 1257L): £741.20\nNational Insurance: £285.12\nPension (employee 5%): £237.50\nStudent loan (Plan 2): £73.60\nNet pay: £3,412.58",
      "Your employee number is 482913 and your National Insurance number is QQ 12 34 56 C. Please check your tax code: if you started another job during the year, HMRC may issue a new one and we will apply it as soon as we receive the notice.",
      "From April, payslips will only be available in the employee self-service portal. Use your employee number and the temporary password we will send to your home address to log in for the first time; you will then be asked to choose a new password. If you are locked out later, HR can arrange a password reset.",
      "Annual leave: you have 11.5 days remaining for this leave year, which ends on 31 March. Up to five days can be carried over with your manager's approval.",
      "If anything on your payslip looks wrong, reply to this email or contact the payroll team on extension 4829 before the 20th of the month.",
      "Best wishes,\n\nPayroll Team\nNorthfield Retail Group",
    ),
  },
  {
    id: "fr/payroll monthly payslip", lang: "fr", category: "payroll",
    subject: "Votre fiche de salaire de mars 2026",
    text: doc(
      "Bonjour Madame Lambert,",
      "Vous trouverez en annexe votre fiche de salaire du mois de mars 2026. Le versement sera effectué le 25 mars 2026 sur votre compte IBAN CH51 0078 8000 0501 2345 6.",
      "Récapitulatif :\n- Salaire brut : CHF 6 920.00\n- AVS/AI/APG (5,3 %) : CHF 366.75\n- AC (1,1 %) : CHF 76.10\n- Caisse de pension : CHF 448.20\n- Impôt à la source : CHF 612.35\n- Salaire net : CHF 5 416.60",
      "Votre numéro de personnel est le 482913 et votre numéro AVS le 756.9876.5432.10. Merci de vérifier ces informations et de signaler toute différence au service du personnel avant la fin du mois.",
      "Dès avril, les fiches de salaire seront disponibles uniquement sur le portail des collaborateurs. Pour la première connexion, utilisez votre numéro de personnel et le mot de passe provisoire que le service du personnel vous enverra par courrier. Vous devrez ensuite modifier votre mot de passe. Confirmez votre adresse privée sur le portail afin que le certificat de salaire 2026 vous parvienne correctement.",
      "Pour toute question, veuillez vous adresser à Nadia Favre, administration du personnel, au 022 482 91 37.",
      "Meilleures salutations,\n\nService du personnel\nTransports Genevois Express SA\nRoute de Meyrin 49, 1203 Genève",
    ),
  },
  {
    id: "it/payroll monthly payslip", lang: "it", category: "payroll",
    subject: "Il suo conteggio salariale di marzo 2026",
    text: doc(
      "Buongiorno signora Colombo,",
      "in allegato trova il conteggio salariale del mese di marzo 2026. Il versamento sarà effettuato il 25 marzo 2026 sul suo conto IBAN CH12 0076 4123 4567 8901 2.",
      "Riepilogo:\n- Salario lordo: CHF 6 480.00\n- AVS/AI/IPG (5,3 %): CHF 343.45\n- AD (1,1 %): CHF 71.30\n- Cassa pensione: CHF 419.80\n- Imposta alla fonte: CHF 574.10\n- Salario netto: CHF 5 071.35",
      "Il suo numero di personale è 482913 e il suo numero AVS è 756.1111.2222.33. La preghiamo di verificare i dati e di segnalare eventuali differenze all'ufficio del personale entro la fine del mese.",
      "Da aprile i conteggi salariali saranno disponibili solo sul portale dei collaboratori. Per il primo accesso utilizzi il suo numero di personale e la password provvisoria che l'ufficio del personale le invierà per posta; al primo accesso le verrà chiesto di modificare la password. Il nuovo accesso al portale per i collaboratori a tempo parziale è previsto per maggio.",
      "Per qualsiasi domanda si rivolga a Sara Galli, amministrazione del personale, al numero 091 482 91 37.",
      "Cordiali saluti\n\nUfficio del personale\nTrasporti Ticino Express SA\nVia San Gottardo 44, 6900 Lugano",
    ),
  },

  // ══ notary and fiduciary letters ═════════════════════════════════════════════════════════
  {
    id: "de/notary deed appointment", lang: "de", category: "notary",
    subject: "Beurkundung Kaufvertrag Stockwerkeigentum – Termin und Unterlagen",
    attachments: ["Kaufvertrag_Entwurf.pdf"],
    text: doc(
      "Sehr geehrte Frau und Herr Wyss",
      "Wir bestätigen Ihnen den Termin für die öffentliche Beurkundung des Kaufvertrags über die Stockwerkeinheit an der Gartenstrasse 7 in Uster am Donnerstag, 23. April 2026, 14.00 Uhr, in unserem Büro.",
      "Im Anhang erhalten Sie den Vertragsentwurf. Bitte prüfen Sie insbesondere:",
      "- den Kaufpreis von CHF 1 185 000.00 und die Zahlungsmodalitäten (Anzahlung CHF 118 500.00 bei Beurkundung, Restzahlung bei Eigentumsübertragung am 30. Juni 2026),\n- die Grundstücksnummer 4829 im Grundbuch Uster und die dazugehörigen Wertquoten,\n- die Regelung zur Grundstückgewinnsteuer und zur Handänderungssteuer.",
      "Bitte bringen Sie zur Beurkundung einen gültigen Pass oder eine Identitätskarte mit. Das Zahlungsversprechen Ihrer Bank benötigen wir spätestens drei Arbeitstage vor dem Termin.",
      "Bestätigen Sie Ihre Teilnahme bitte bis 10. April 2026 per E-Mail. Die Unterlagen für das Grundbuchamt reichen wir nach der Beurkundung elektronisch ein; die Quittung mit dem Bestätigungscode des Grundbuchamts leiten wir Ihnen weiter.",
      "Die Kosten für die Beurkundung und die Grundbuchgebühren teilen sich Käufer und Verkäufer gemäss Ziffer 14 des Vertrags je zur Hälfte.",
      "Freundliche Grüsse\n\nlic. iur. Andreas Keller, Notar\nNotariat Uster\nBahnhofstrasse 20, 8610 Uster",
    ),
  },
  {
    id: "de/notary fiduciary annual accounts", lang: "de", category: "notary", html: true,
    subject: "Jahresabschluss 2025 der Muster Holzbau GmbH – Unterlagen zur Genehmigung",
    attachments: ["Jahresabschluss_2025.pdf", "Protokoll_GV_2026_Entwurf.pdf"],
    text: doc(
      "Guten Tag Herr Brunner",
      "Der Jahresabschluss 2025 der Muster Holzbau GmbH ist fertiggestellt. Im Anhang erhalten Sie die Bilanz, die Erfolgsrechnung, den Anhang sowie den Entwurf des Protokolls der Gesellschafterversammlung zur Genehmigung.",
      "Die wichtigsten Kennzahlen:\n- Umsatz: CHF 2 482 913.00 (Vorjahr CHF 2 301 450.00)\n- Jahresgewinn: CHF 148 220.00\n- Eigenkapital per 31.12.2025: CHF 612 400.00\n- Vorgeschlagene Dividende: CHF 60 000.00",
      "Die Mehrwertsteuerabrechnung für das vierte Quartal haben wir mit der Referenz 482913 über das Portal der Steuerverwaltung eingereicht; die Bestätigung der Einreichung liegt bei. Für die nächste Abrechnung benötigen wir keinen neuen Zugangscode, da unsere Vollmacht weiterhin gültig ist.",
      "Bitte prüfen Sie die Unterlagen und bestätigen Sie Ihre Zustimmung zum Gewinnverwendungsvorschlag bis zum 20. April 2026. Die Gesellschafterversammlung muss spätestens sechs Monate nach Abschluss des Geschäftsjahres stattfinden.",
      "Zur Erinnerung: Die neue Anmeldung Ihrer Mitarbeitenden bei der Ausgleichskasse für das Jahr 2026 ist erfolgt. Die Lohnsumme haben wir mit CHF 842 000.00 gemeldet.",
      "Das Kennwort für das PDF-Dossier erhalten Sie wie gewohnt telefonisch.",
      "Freundliche Grüsse\n\nMonika Brunner\nBrunner Treuhand AG\nBahnhofstrasse 12, 8001 Zürich",
    ),
  },
  {
    id: "en/notary property completion", lang: "en", category: "notary",
    subject: "Completion of your purchase of 14 Orchard Lane – next steps",
    text: doc(
      "Dear Mr and Mrs Chen,",
      "We are pleased to confirm that exchange of contracts on your purchase of 14 Orchard Lane, Harrogate, took place today, and that completion is fixed for Friday 24 April 2026.",
      "Before completion we need the following from you:\n1. The balance of the purchase price, £48,291.37 after your deposit, to be in our client account by 12 noon on Wednesday 22 April. Our bank details are in the enclosed completion statement. Please telephone us on the number printed on our letterhead to confirm them before you transfer any money: we will never change our bank details by email.\n2. Your signed Stamp Duty Land Tax return. We will submit it on completion and send you the certificate with its unique transaction reference.\n3. Confirmation that you have arranged buildings insurance from the date of exchange.",
      "On the day of completion the keys will be released by the selling age" + "nts once we have confirmed that the funds have reached the seller's solicitors. The age" + "nts will also give you the access code for the side gate and the alarm; you should change the alarm code as soon as you move in.",
      "Land Registry: after completion we will apply to register you as the owners. Title number NYK482913 will be updated and we will send you a copy of the register once registration is complete, which usually takes a few weeks.",
      "Please verify your identity documents are still valid, as we must hold current copies under the money laundering regulations.",
      "Yours sincerely,\n\nRebecca Stone\nPartner, Residential Property\nStone & Ashworth LLP, Solicitors\n3 Parliament Street, Harrogate HG1 2QU",
    ),
  },
  {
    id: "fr/notary deed appointment", lang: "fr", category: "notary",
    subject: "Signature de l'acte de vente – rendez-vous et documents",
    text: doc(
      "Madame, Monsieur Dupuis,",
      "Nous vous confirmons le rendez-vous pour la signature de l'acte de vente de l'appartement situé Chemin des Vignes 5 à Pully, le jeudi 23 avril 2026 à 14 h 00, en notre étude.",
      "Vous trouverez en annexe le projet d'acte. Nous vous prions de vérifier en particulier :\n- le prix de vente de CHF 1 185 000.00 et les modalités de paiement,\n- le numéro de parcelle 4829 au registre foncier de Pully,\n- les dispositions relatives à l'impôt sur les gains immobiliers et aux droits de mutation.",
      "Confirmez votre présence d'ici au 10 avril 2026 par retour de courriel. Munissez-vous d'une pièce d'identité valable ; la promesse de paiement de votre banque doit nous parvenir au plus tard trois jours ouvrables avant la signature.",
      "Après la signature, nous déposerons la réquisition au registre foncier par voie électronique. Le code de confirmation du dépôt vous sera transmis avec la quittance.",
      "Les frais de l'acte et les émoluments du registre foncier sont partagés par moitié entre l'acheteur et le vendeur, conformément à l'article 14 du projet.",
      "Veuillez agréer, Madame, Monsieur, nos salutations distinguées.\n\nMe Laurent Chappuis, notaire\nÉtude Chappuis & Rey\nAvenue de Lavaux 12, 1009 Pully",
    ),
  },
  {
    id: "it/notary deed appointment", lang: "it", category: "notary",
    subject: "Rogito di compravendita – appuntamento e documenti",
    text: doc(
      "Gentili signori Rinaldi,",
      "vi confermiamo l'appuntamento per la stipula del rogito di compravendita dell'appartamento in Via ai Monti 17 a Locarno, giovedì 23 aprile 2026 alle ore 14.00 nel nostro studio.",
      "In allegato trovate la bozza dell'atto. Vi preghiamo di verificare in particolare:\n- il prezzo di vendita di CHF 985 000.00 e le modalità di pagamento,\n- il numero di mappale 4829 del registro fondiario di Locarno,\n- le disposizioni sull'imposta sugli utili immobiliari e sulla tassa di trapasso.",
      "Potete confermare l'appuntamento rispondendo a questa email oppure dal nostro sistema di prenotazione online, il cui promemoria dice «Conferma il tuo appuntamento» e va confermato entro il 10 aprile 2026. Portate con voi un documento d'identità valido; la promessa di pagamento della vostra banca deve pervenirci al più tardi tre giorni lavorativi prima della stipula.",
      "Dopo la stipula depositeremo la notifica al registro fondiario per via elettronica; il codice di conferma del deposito vi sarà inoltrato insieme alla ricevuta.",
      "Le spese notarili e le tasse del registro fondiario sono ripartite a metà tra acquirente e venditore, come previsto all'articolo 14 della bozza.",
      "Distinti saluti\n\nAvv. Paolo Bianchi, notaio\nStudio legale e notarile Bianchi\nPiazza Grande 8, 6600 Locarno",
    ),
  },
];

/**
 * The same documents CARRYING a credential value beside its cue. A code beside its cue is the
 * delivery whatever the length (ruling 2026-09-26), so each reads `sensitive`/`otp`: the cue is
 * backed, which is exactly what the documents above never are. Each inserts one sentence.
 */
export const DOCUMENTS_CARRYING_A_CODE: ReadonlyArray<readonly [id: string, base: string, sentence: string]> = [
  ["de/tax office letter with the access code", "de/tax assessment from the tax office",
    "Ihr persönlicher Zugangscode für die Einreichung 2025 lautet 4829 1374."],
  ["de/tax return with the alphanumeric access code", "de/tax fiduciary return for review",
    "Auf dem Deckblatt steht der Zugangscode: K" + "7QM-2P9X-48TZ."],
  ["en/bank letter with an activation code", "en/bank new card and changed terms",
    "Your activation code for online banking is 48291374."],
  ["fr/insurance letter with a verification code", "fr/insurance household policy",
    "Votre code de vérification pour l'espace client : 552 918."],
  ["it/contract with an access code", "it/contract commercial lease",
    "Il codice di accesso al magazzino è 7310 4482."],
];

/**
 * The other side of the line: REAL notices as providers send them — a device check, an e-banking
 * code under a legal footer, a sign-in code under a marketing block, a welcome mail asking to
 * confirm the address, alerts and resets; 72–145 prose words. Every one must stay `sensitive` with
 * the pinned category. Invented brands; the shapes are the providers'.
 */
export interface NoticeCase {
  id: string;
  subject: string;
  text: string;
  html?: boolean;
  category: "otp" | "verification" | "password_reset" | "security_alert";
}

export function noticeMessage(c: NoticeCase): NormalizedMessage {
  return {
    canonical: { messageIdHeader: null, bodyHash: "x" },
    subject: c.subject, from: { name: null, address: "no-reply@service.invalid" }, to: [], cc: [],
    date: null, headers: {}, textBody: c.text, htmlBody: c.html ? asHtml(c.text) : null,
    hasAttachments: false, attachments: [],
  };
}

export const LONG_NOTICES: NoticeCase[] = [
  {
    id: "en/device verification with advice", category: "otp", html: true,
    subject: "[Forgewood] Please verify your device",
    text: doc(
      "Hey mkeller!",
      "A sign in attempt requires further verification because we did not recognize your device. To complete the sign in, enter the verification code on the unrecognized device.",
      "Device: Firefox on Linux\nVerification code: 482913",
      "If you did not attempt to sign in to your account, your password may be compromised. Visit https://forgewood.example/settings/security to create a new, strong password for your Forgewood account.",
      "If you'd like to automatically verify devices in the future, consider enabling two-factor authentication on your account. Visit https://docs.forgewood.example/2fa to learn about two-factor authentication.",
      "If you decide to enable two-factor authentication, ensure you retain access to one or more account recovery methods.",
      "Thanks,\nThe Forgewood Team",
    ),
  },
  {
    id: "de/e-banking code under a legal footer", category: "otp", html: true,
    subject: "Ihr Sicherheitscode für das E-Banking",
    text: doc(
      "Guten Tag",
      "Für die Anmeldung im E-Banking geben Sie bitte den folgenden Sicherheitscode ein:",
      "482913",
      "Der Code ist 10 Minuten gültig und kann nur einmal verwendet werden. Geben Sie diesen Code niemals an Dritte weiter – unsere Mitarbeitenden werden Sie nie danach fragen, weder am Telefon noch per E-Mail.",
      "Falls Sie keine Anmeldung veranlasst haben, sperren Sie Ihren Zugang bitte umgehend über die Hotline, die rund um die Uhr erreichbar ist.",
      "Freundliche Grüsse\nIhre Seeland Bank",
      "Diese E-Mail wurde automatisch erstellt; bitte antworten Sie nicht darauf. Seeland Bank AG, Bahnhofplatz 1, 2502 Biel. Informationen zum Umgang mit Ihren Daten finden Sie in unserer Datenschutzerklärung. Wenn Sie Fragen zu dieser Nachricht haben, wenden Sie sich an Ihre Kundenberaterin oder Ihren Kundenberater.",
    ),
  },
  {
    id: "en/sign-in code under a marketing block", category: "otp",
    subject: "Your Harbor Market sign-in code",
    text: doc(
      "Hi there,",
      "Your sign-in code is 482913. Enter it in the app or on the website to finish signing in. The code expires in 15 minutes.",
      "If you didn't try to sign in, you can ignore this email. Someone may have typed your email address by mistake, and your account is still secure.",
      "For your security, never share this code with anyone, including Harbor Market staff.",
      "This week at Harbor Market\nFresh from the farm: summer berries are back, with free delivery on orders over $50 until Sunday. Members save an extra 10% on household essentials, and our new recipe collection has 30 quick dinners for busy weeknights.",
      "Download the Harbor Market app for faster checkout and order tracking.",
      "Harbor Market, 200 Pier Avenue, Seattle, WA 98101. You're receiving this email because you have a Harbor Market account. Manage email preferences · Privacy policy · Help centre",
    ),
  },
  {
    id: "it/verification code with footer", category: "otp",
    subject: "Il tuo codice di verifica",
    text: doc(
      "Ciao,",
      "ecco il codice per accedere a Mercato Ticino:",
      "482913",
      "Il codice scade tra 10 minuti. Se non hai richiesto tu questo codice, puoi ignorare questa email: qualcuno potrebbe aver digitato il tuo indirizzo per errore.",
      "Non condividere questo codice con nessuno. Il nostro servizio clienti non ti chiederà mai il codice.",
      "Grazie,\nil team di Mercato Ticino",
      "Mercato Ticino SA, Via Pretorio 7, 6900 Lugano. Hai ricevuto questa email perché è stato richiesto un accesso al tuo account. Informativa sulla privacy · Termini di servizio",
    ),
  },
  {
    id: "en/security alert with footer", category: "security_alert", html: true,
    subject: "Security alert",
    text: doc(
      "A new sign-in on Windows",
      "We noticed a new sign-in to your Northwind Account on a Windows device. If this was you, you don't need to do anything. If not, we'll help you secure your account.",
      "Check activity",
      "You can also see security activity at https://myaccount.northwind.example/notifications",
      "You received this email to let you know about important changes to your Northwind Account and services.\n© 2026 Northwind LLC, 1600 Harbour Parkway, Mountain View, CA 94043, USA",
    ),
  },
  {
    id: "de/security alert with footer", category: "security_alert",
    subject: "Neue Anmeldung bei Ihrem Konto",
    text: doc(
      "Guten Tag",
      "Wir haben eine neue Anmeldung bei Ihrem Konto festgestellt.",
      "Gerät: Chrome auf Windows\nOrt: Zürich, Schweiz (ungefähr)\nZeit: 14. März 2026, 21:47 Uhr",
      "Waren Sie das? Dann müssen Sie nichts weiter tun. Falls Sie diese Anmeldung nicht kennen, ändern Sie bitte sofort Ihr Passwort und melden Sie sich überall ab.",
      "Ihr Sicherheitsteam von Limmat Cloud",
      "Diese Benachrichtigung erhalten Sie, weil Sicherheitsbenachrichtigungen für Ihr Konto aktiviert sind. Limmat Cloud AG, Hardstrasse 201, 8005 Zürich.",
    ),
  },
  {
    id: "fr/password reset with footer", category: "password_reset",
    subject: "Votre demande de mot de passe",
    text: doc(
      "Bonjour,",
      "Nous avons reçu une demande pour votre compte Voyages Alpins. Pour réinitialiser votre mot de passe, cliquez sur le lien ci-dessous. Ce lien est valable pendant 30 minutes et ne peut être utilisé qu'une seule fois.",
      "https://compte.voyages-alpins.example/reset?token=Qm9uam91ciBtb24gYW1pIDQ4MjkxMw",
      "Si vous n'êtes pas à l'origine de cette demande, vous pouvez ignorer ce message : votre mot de passe actuel reste inchangé.",
      "Pour votre sécurité, ne transférez pas ce courriel.",
      "L'équipe Voyages Alpins\nVoyages Alpins SA · Rue du Mont-Blanc 3 · 1201 Genève\nVous recevez ce message parce qu'une demande a été faite pour votre compte. Politique de confidentialité · Conditions d'utilisation",
    ),
  },
  {
    id: "en/welcome mail asking to confirm the address", category: "verification",
    subject: "Confirm your email address",
    text: doc(
      "Welcome to Fieldnote!",
      "You're almost there. Please confirm your email address so we know it's really you and can keep your account secure.",
      "Confirm email address: https://app.fieldnote.example/confirm?token=b7Qx29LmNa81ZpR4tVw0",
      "This link expires in 24 hours. If you didn't create a Fieldnote account, you can safely ignore this email and nothing will happen.",
      "Once you've confirmed, here are three things to try first:\n1. Create your first notebook and invite a colleague.\n2. Connect your calendar so meeting notes are filed automatically.\n3. Install the mobile app to capture notes on the go.",
      "Need help? Our support team answers every message within one business day.",
      "Cheers,\nThe Fieldnote team",
      "Fieldnote Inc., 548 Market Street, San Francisco, CA 94104. You are receiving this email because you signed up for Fieldnote.",
    ),
  },
  {
    id: "de/registration asking to confirm the address", category: "verification", html: true,
    subject: "Bitte bestätigen Sie Ihre E-Mail-Adresse",
    text: doc(
      "Guten Tag",
      "Vielen Dank für Ihre Registrierung bei Velo Bern. Bitte bestätigen Sie Ihre E-Mail-Adresse, indem Sie auf den folgenden Link klicken:",
      "https://www.velobern.example/registrierung/bestaetigen?token=Zx81Lq4Pw0Ra92MvTt6N",
      "Der Link ist 48 Stunden gültig. Falls Sie sich nicht bei uns registriert haben, können Sie diese E-Mail ignorieren; ohne Bestätigung wird kein Konto eröffnet.",
      "Nach der Bestätigung können Sie Mietvelos reservieren, Ihre Fahrten einsehen und Ihr Abo verwalten.",
      "Freundliche Grüsse\nIhr Velo-Bern-Team",
      "Velo Bern GmbH, Speichergasse 12, 3011 Bern · Datenschutz · Impressum",
    ),
  },
];

/**
 * LONG real-shaped sensitive mail, de and en, 200–400 prose words under legal footers, support
 * text and marketing blocks: a code mail from a bank, a payment service and a large platform, a
 * password reset, a new sign-in alert and an email verification link. Length is not what makes
 * a document; every one must stay `sensitive` beside the 30 business documents staying ordinary.
 */
export const LONG_SENSITIVE: NoticeCase[] = [
  {
    id: "de/bank payment approval code", category: "otp", html: true,
    subject: "Ihr Sicherheitscode für die Zahlungsfreigabe",
    text: doc(
      "Guten Tag Frau Keller",
      "Sie haben im E-Banking eine Zahlung erfasst, die eine zusätzliche Freigabe benötigt. Geben Sie dazu den folgenden Sicherheitscode im E-Banking ein:",
      "Sicherheitscode: 482913",
      "Der Code ist 5 Minuten gültig und gilt nur für diese eine Zahlung. Details der Zahlung: Empfänger Muster Immobilien AG, Betrag CHF 1 250.00, Ausführung am 28.03.2026.",
      "Wenn Sie diese Zahlung nicht erfasst haben, geben Sie den Code nicht ein. Sperren Sie Ihren Zugang umgehend über die Sperrnummer und kontaktieren Sie unseren Kundendienst. Wir werden Sie nie per E-Mail, SMS oder Telefon auffordern, einen Sicherheitscode, Ihr Passwort oder Ihre Kartendaten bekanntzugeben.",
      "Sicherheitshinweise\n- Prüfen Sie vor jeder Freigabe den Empfänger und den Betrag.\n- Öffnen Sie keine Links in Nachrichten, die angeblich von uns stammen und Sie zur Eingabe von Zugangsdaten auffordern.\n- Halten Sie das Betriebssystem und den Browser Ihres Geräts aktuell.",
      "Freundliche Grüsse\nIhre Seeland Bank",
      "Kundendienst: Montag bis Freitag 08.00–18.00 Uhr, Samstag 09.00–12.00 Uhr. Sperrnummer rund um die Uhr.",
      "Diese E-Mail wurde automatisch erstellt; bitte antworten Sie nicht auf diese Nachricht. Seeland Bank AG, Bahnhofplatz 1, 2502 Biel. Die Seeland Bank AG untersteht der Aufsicht der Eidgenössischen Finanzmarktaufsicht. Informationen zum Umgang mit Ihren Personendaten finden Sie in unserer Datenschutzerklärung. Diese Nachricht ist ausschliesslich für den bezeichneten Empfänger bestimmt. Sollten Sie diese E-Mail irrtümlich erhalten haben, bitten wir Sie, den Absender zu benachrichtigen und die Nachricht zu löschen. Jede unbefugte Verwendung, Weitergabe oder Vervielfältigung ist untersagt. E-Mails können auf dem Übertragungsweg verändert oder eingesehen werden; die Bank übernimmt keine Haftung für Schäden, die daraus entstehen.",
    ),
  },
  {
    id: "en/bank card payment passcode", category: "otp",
    subject: "Your one-time passcode",
    text: doc(
      "Dear customer,",
      "You are making an online card payment with your Lakeland Savings Bank debit card ending 5521. To confirm it's you, enter this one-time passcode on the merchant's payment page:",
      "482913",
      "This passcode is valid for 10 minutes and can only be used for this payment of GBP 84.99 to HARBOR MARKET ONLINE. If you did not try to make this payment, do not enter the passcode. Call us straight away on the number on the back of your card and we will block the card.",
      "Remember: we will never ask you to share a passcode, your PIN or your online banking password, by phone, email or text message. A genuine member of our staff will never ask you to move money to a safe account.",
      "Staying safe online\n- Only enter a passcode on a payment page you opened yourself.\n- Check that the merchant name and amount match your purchase before you confirm.\n- If something feels wrong, stop and call us. Fraudsters often create a sense of urgency.",
      "Thank you for banking with us.\n\nLakeland Savings Bank",
      "This is an automated email. Please do not reply to it, as replies are not monitored. Lakeland Savings Bank plc is authorised by the Prudential Regulation Authority and regulated by the Financial Conduct Authority and the Prudential Regulation Authority. Registered in England and Wales, company number 01234567. Registered office: 1 Lakeside Place, Kendal LA9 4AB. Calls may be recorded for training and monitoring purposes. Our privacy notice explains how we use your personal information and your rights; you can read it on our website or ask for a copy in branch.",
    ),
  },
  {
    id: "de/payment service sign-in code", category: "otp",
    subject: "Ihr Bestätigungscode für PayFlow",
    text: doc(
      "Hallo Marco",
      "Jemand möchte sich mit Ihrer E-Mail-Adresse bei PayFlow anmelden. Wenn Sie das sind, geben Sie diesen Bestätigungscode ein:",
      "482913",
      "Der Code läuft in 10 Minuten ab. Teilen Sie ihn mit niemandem – auch nicht mit Personen, die sich als Mitarbeitende von PayFlow ausgeben. Wir fragen Sie nie nach diesem Code.",
      "Sie haben keine Anmeldung versucht? Dann können Sie diese E-Mail ignorieren. Ihr Konto bleibt geschützt, solange niemand den Code kennt. Wenn Sie vermuten, dass jemand Ihr Passwort kennt, ändern Sie es in den Einstellungen unter «Sicherheit».",
      "Wussten Sie schon?\nMit PayFlow bezahlen Sie online in über 200 Märkten, senden Geld an Freunde und Familie und behalten Ihre Ausgaben in der App im Blick. Aktivieren Sie die Benachrichtigungen, um jede Zahlung sofort zu sehen.",
      "Hilfe und Kontakt\nAntworten auf häufige Fragen finden Sie in unserem Hilfe-Center. Unser Kundenservice ist rund um die Uhr per Chat erreichbar.",
      "PayFlow (Europe) S.à r.l. et Cie, S.C.A., 22–24 Boulevard Royal, L-2449 Luxembourg. PayFlow ist in Luxemburg als Kreditinstitut zugelassen und untersteht der Aufsicht der luxemburgischen Finanzaufsicht. Diese E-Mail wurde an die Adresse gesendet, die mit Ihrem PayFlow-Konto verknüpft ist. Sie erhalten diese Nachricht, weil sie für die Sicherheit Ihres Kontos wichtig ist; Sie können sie deshalb nicht abbestellen. Datenschutz · Nutzungsbedingungen · Impressum",
    ),
  },
  {
    id: "en/payment service security code", category: "otp", html: true,
    subject: "Your PayFlow security code",
    text: doc(
      "Hi Marco,",
      "Your PayFlow security code is 482913.",
      "Use it to finish logging in. It expires in 10 minutes. Never share this code with anyone, not even someone who says they work for PayFlow. We will never call, text or email you to ask for it.",
      "Didn't try to log in? Someone may have entered your email address by mistake. You can ignore this email, and your account will stay safe as long as nobody else has the code. If you think someone knows your password, change it now in Settings, then review the devices that are signed in to your account.",
      "Did you know?\nWith PayFlow you can pay online in more than 200 markets, send money to friends and family, and see every payment in the app the moment it happens. Turn on notifications so nothing surprises you.",
      "Help and contact\nYou'll find answers to common questions in our Help Centre, and our customer service team is available around the clock by chat. For your security, we'll only ever discuss your account after you've logged in.",
      "PayFlow (Europe) S.à r.l. et Cie, S.C.A., 22–24 Boulevard Royal, L-2449 Luxembourg. PayFlow is licensed as a credit institution in Luxembourg and supervised by the Luxembourg financial regulator. This email was sent to the address linked to your PayFlow account. You're receiving it because it concerns the security of your account, so you can't unsubscribe from it. Privacy · User agreement · Legal",
    ),
  },
  {
    id: "en/platform recovery verification code", category: "otp", html: true,
    subject: "Your Northwind verification code",
    text: doc(
      "Northwind",
      "Verification code",
      "Use this code to finish setting up your Northwind Account recovery email:",
      "482913",
      "This code will expire in 24 hours.",
      "If you don't recognise this request, you can safely ignore this email. Someone might have typed your email address by mistake. You don't need to do anything else, and no changes will be made to your account.",
      "Why you received this email\nNorthwind asks for a verification code whenever a new recovery email or phone number is added to an account, or when a sign-in needs an extra check. Recovery options help you get back into your account if you ever forget your password or get locked out, and they let us warn you about suspicious activity.",
      "Keep your account secure\n- Review your recovery email and phone number regularly and remove any you no longer use.\n- Turn on 2-Step Verification for an extra layer of protection.\n- Run a Security Checkup to see personalised recommendations for your account.",
      "You received this mandatory service email to let you know about important changes to your Northwind Account and services.\n© 2026 Northwind LLC, 1600 Harbour Parkway, Mountain View, CA 94043, USA",
      "Northwind will never ask you to share this code, and a Northwind employee will never ask for your password. If you get a message asking for either, it isn't from us. Learn more about keeping your account safe in the Northwind Help Centre, where you can also report suspicious messages.",
    ),
  },
  {
    id: "de/platform sign-in code", category: "otp",
    subject: "Ihr Northwind-Bestätigungscode",
    text: doc(
      "Northwind",
      "Bestätigungscode",
      "Verwenden Sie diesen Code, um die Anmeldung bei Ihrem Northwind-Konto abzuschliessen:",
      "482913",
      "Der Code läuft in 15 Minuten ab. Fordern Sie danach in der App einen neuen Code an.",
      "Wenn Sie diese Anfrage nicht kennen, können Sie diese E-Mail ignorieren. Möglicherweise hat jemand Ihre E-Mail-Adresse versehentlich eingegeben. Sie müssen nichts weiter tun, und an Ihrem Konto wird nichts geändert.",
      "Warum Sie diese E-Mail erhalten\nNorthwind fragt nach einem Bestätigungscode, wenn Sie sich auf einem neuen Gerät anmelden oder eine Anmeldung zusätzlich geprüft werden muss. So stellen wir sicher, dass nur Sie auf Ihr Konto zugreifen können, auch wenn jemand Ihr Passwort kennt.",
      "So schützen Sie Ihr Konto\n- Prüfen Sie regelmässig Ihre Wiederherstellungsadresse und Ihre Telefonnummer.\n- Aktivieren Sie die Bestätigung in zwei Schritten.\n- Führen Sie den Sicherheitscheck durch, um persönliche Empfehlungen zu erhalten.",
      "Sie haben diese obligatorische Service-E-Mail erhalten, um Sie über wichtige Änderungen an Ihrem Northwind-Konto und an Ihren Diensten zu informieren.\n© 2026 Northwind LLC, 1600 Harbour Parkway, Mountain View, CA 94043, USA",
      "Northwind wird Sie nie auffordern, diesen Code weiterzugeben, und Mitarbeitende von Northwind fragen nie nach Ihrem Passwort. Wenn Sie eine solche Nachricht erhalten, stammt sie nicht von uns. Weitere Informationen zur Sicherheit Ihres Kontos finden Sie in der Northwind-Hilfe.",
    ),
  },
  {
    id: "en/password reset under a long footer", category: "password_reset",
    subject: "Reset your Fieldnote password",
    text: doc(
      "Hi Maria,",
      "We received a request to reset the password for your Fieldnote account. Click the link below to choose a new password. The link is valid for 60 minutes and can be used once.",
      "https://app.fieldnote.example/reset-password?token=Q2hhbmdlTWUtNDgyOTEzLWxpbms",
      "If you didn't ask to reset your password, you can ignore this email and your password will stay the same. Someone may have entered your email address by mistake. If you keep receiving these emails without asking for them, please let our support team know.",
      "A few tips for a strong password\n- Use at least twelve characters, and avoid words that are easy to guess.\n- Don't reuse a password you use for another service.\n- Consider a password manager, which can create and remember strong passwords for you.\n- Turn on two-step verification in your account settings for extra protection.",
      "What's new in Fieldnote\nShared notebooks now sync in real time, meeting notes can be filed automatically from your calendar, and the mobile app lets you capture voice memos that are transcribed as you speak. Read more on our blog.",
      "Need help? Our support team answers every message within one business day. You can also browse hundreds of articles in the Help Centre.",
      "Cheers,\nThe Fieldnote team",
      "Fieldnote Inc., 548 Market Street, San Francisco, CA 94104, USA. You are receiving this email because a password reset was requested for your account. This is a service message about your account, so it is sent even if you have unsubscribed from marketing emails. Privacy policy · Terms of service · Security",
    ),
  },
  {
    id: "de/password reset under a long footer", category: "password_reset", html: true,
    subject: "Passwort zurücksetzen",
    text: doc(
      "Guten Tag Frau Meier",
      "Wir haben eine Anfrage erhalten, das Passwort für Ihr Konto bei Velo Bern zurückzusetzen. Klicken Sie auf den folgenden Link, um ein neues Passwort festzulegen. Der Link ist 60 Minuten gültig und kann nur einmal verwendet werden.",
      "https://www.velobern.example/konto/passwort-zuruecksetzen?token=Vm9uZXV0emVyLTQ4MjkxMy1saW5r",
      "Falls Sie keine Anfrage gestellt haben, können Sie diese E-Mail ignorieren. Ihr bisheriges Passwort bleibt gültig. Möglicherweise hat jemand Ihre E-Mail-Adresse versehentlich eingegeben. Wenn Sie solche E-Mails wiederholt erhalten, ohne sie angefordert zu haben, wenden Sie sich bitte an unseren Kundendienst.",
      "Tipps für ein sicheres Passwort\n- Verwenden Sie mindestens zwölf Zeichen und keine leicht zu erratenden Wörter.\n- Verwenden Sie kein Passwort, das Sie bereits für einen anderen Dienst nutzen.\n- Ein Passwort-Manager kann sichere Passwörter für Sie erstellen und speichern.",
      "Neu bei Velo Bern\nAb April stehen an zwölf neuen Standorten E-Bikes bereit, und mit dem Jahresabo fahren Sie die ersten 30 Minuten jeder Fahrt kostenlos. Alle Neuigkeiten finden Sie in unserem Blog.",
      "Haben Sie Fragen? Unser Kundendienst ist von Montag bis Samstag erreichbar und beantwortet jede Nachricht innert eines Arbeitstages.",
      "Freundliche Grüsse\nIhr Velo-Bern-Team",
      "Velo Bern GmbH, Speichergasse 12, 3011 Bern. Sie erhalten diese E-Mail, weil für Ihr Konto eine Zurücksetzung des Passworts angefordert wurde. Es handelt sich um eine Service-Mitteilung zu Ihrem Konto; sie wird auch versendet, wenn Sie den Newsletter abbestellt haben. Datenschutz · AGB · Impressum",
    ),
  },
  {
    id: "en/new sign-in alert", category: "security_alert", html: true,
    subject: "New sign-in to your Northwind Account",
    text: doc(
      "Northwind",
      "A new sign-in on Windows",
      "We noticed a new sign-in to your Northwind Account on a Windows device. If this was you, you don't need to do anything. If not, we'll help you secure your account.",
      "Device: Windows 11, Chrome\nLocation: near Zurich, Switzerland\nTime: Thursday, 26 March 2026, 21:47 (Central European Time)",
      "Check activity: https://myaccount.northwind.example/notifications",
      "If you don't recognise this activity\nSomeone might have your password. Change your password right away, then review the devices that are signed in to your account and sign out of any you don't recognise. You can also check whether any recovery options or forwarding rules were changed without your knowledge.",
      "Why we sent this\nWe send security alerts whenever your account is used on a device or in a location we haven't seen before, so that you can act quickly if someone else is trying to get in. Alerts like this can't be turned off, because they protect your account.",
      "Keep your account secure\n- Turn on 2-Step Verification so a password alone isn't enough to sign in.\n- Use a unique password that you don't use on any other site.\n- Keep your recovery phone number and email address up to date.",
      "You received this email to let you know about important changes to your Northwind Account and services.\n© 2026 Northwind LLC, 1600 Harbour Parkway, Mountain View, CA 94043, USA",
      "Northwind will never ask you for your password or a verification code in an email. If you're unsure whether a message is from us, don't click its links: go to your account directly instead.",
    ),
  },
  {
    id: "de/new sign-in alert", category: "security_alert",
    subject: "Sicherheitswarnung: Neue Anmeldung bei Ihrem Konto",
    text: doc(
      "Guten Tag",
      "Wir haben eine neue Anmeldung bei Ihrem Limmat-Cloud-Konto auf einem Gerät festgestellt, das wir noch nicht kennen.",
      "Gerät: Chrome auf Windows 11\nOrt: in der Nähe von Zürich, Schweiz\nZeit: Donnerstag, 26. März 2026, 21:47 Uhr",
      "Waren Sie das? Dann müssen Sie nichts weiter tun.",
      "Sie erkennen diese Anmeldung nicht?\nDann kennt möglicherweise jemand Ihr Passwort. Ändern Sie Ihr Passwort sofort, prüfen Sie die angemeldeten Geräte und melden Sie unbekannte Geräte ab. Kontrollieren Sie ausserdem, ob Weiterleitungsregeln oder Wiederherstellungsangaben ohne Ihr Wissen geändert wurden.",
      "Warum Sie diese Nachricht erhalten\nWir senden eine Sicherheitswarnung, wenn Ihr Konto auf einem neuen Gerät oder an einem neuen Ort verwendet wird. So können Sie rasch reagieren, falls jemand anderes versucht, auf Ihr Konto zuzugreifen. Diese Warnungen lassen sich nicht abbestellen, weil sie Ihr Konto schützen.",
      "So schützen Sie Ihr Konto\n- Aktivieren Sie die Bestätigung in zwei Schritten.\n- Verwenden Sie ein Passwort, das Sie nirgendwo sonst nutzen.\n- Halten Sie Ihre Telefonnummer und Ihre Wiederherstellungsadresse aktuell.",
      "Ihr Sicherheitsteam von Limmat Cloud",
      "Limmat Cloud AG, Hardstrasse 201, 8005 Zürich. Diese Benachrichtigung erhalten Sie, weil Sicherheitsbenachrichtigungen für Ihr Konto obligatorisch sind. Limmat Cloud wird Sie nie per E-Mail nach Ihrem Passwort oder nach einem Bestätigungscode fragen. Wenn Sie unsicher sind, ob eine Nachricht von uns stammt, öffnen Sie keine Links darin, sondern melden Sie sich direkt auf unserer Website an. Datenschutz · Impressum",
    ),
  },
  {
    id: "en/email verification link", category: "verification", html: true,
    subject: "Verify your email address for Harbor Market",
    text: doc(
      "Welcome to Harbor Market!",
      "Thanks for creating an account. Before you can place your first order, please verify your email address by clicking the button below. This helps us make sure we can reach you about your orders and keep your account secure.",
      "Verify email address: https://www.harbormarket.example/account/verify?token=SGFyYm9yTWFya2V0LTQ4MjkxMw",
      "This link will expire in 48 hours. If it has expired, sign in and we'll send you a new one. If you didn't create a Harbor Market account, you can ignore this email and no account will be activated.",
      "Once your email is verified, you can:\n- Save your favourite products and get alerts when they're back in stock.\n- Track your orders and manage returns in one place.\n- Join Harbor Rewards and earn points on every purchase.",
      "This week at Harbor Market\nFresh from the farm: summer berries are back, with free delivery on orders over $50 until Sunday. Members save an extra 10% on household essentials, and our new recipe collection has 30 quick dinners for busy weeknights.",
      "Questions? Our customer care team is available seven days a week by chat and phone, and our Help Centre has answers to the most common questions about delivery, payments and returns.",
      "Harbor Market, 200 Pier Avenue, Seattle, WA 98101, USA. You're receiving this email because someone used this address to create a Harbor Market account. If this wasn't you, no further emails will be sent. Manage email preferences · Privacy policy · Terms of use",
    ),
  },
  {
    id: "de/email verification link", category: "verification",
    subject: "Bestätigen Sie Ihre E-Mail-Adresse",
    text: doc(
      "Willkommen bei Mercato Ticino!",
      "Vielen Dank für Ihre Registrierung. Bevor Sie Ihre erste Bestellung aufgeben können, bestätigen Sie bitte Ihre E-Mail-Adresse über den folgenden Link. So stellen wir sicher, dass wir Sie zu Ihren Bestellungen erreichen, und schützen Ihr Konto.",
      "E-Mail-Adresse bestätigen: https://www.mercato-ticino.example/konto/bestaetigen?token=TWVyY2F0b1RpY2luby00ODI5MTM",
      "Der Link ist 48 Stunden gültig. Ist er abgelaufen, melden Sie sich an, und wir senden Ihnen einen neuen. Wenn Sie kein Konto bei Mercato Ticino eröffnet haben, können Sie diese E-Mail ignorieren; ohne Bestätigung wird kein Konto aktiviert.",
      "Nach der Bestätigung können Sie:\n- Lieblingsprodukte speichern und benachrichtigt werden, sobald sie wieder verfügbar sind,\n- Ihre Bestellungen verfolgen und Rücksendungen an einem Ort verwalten,\n- dem Treueprogramm beitreten und bei jedem Einkauf Punkte sammeln.",
      "Diese Woche bei Mercato Ticino\nDie ersten Tessiner Spargeln sind da, und bis Sonntag liefern wir ab CHF 50.00 Bestellwert kostenlos. Mitglieder sparen zusätzlich 10 % auf Haushaltsartikel.",
      "Fragen? Unser Kundendienst ist sieben Tage die Woche per Chat und Telefon für Sie da, und im Hilfe-Center finden Sie Antworten zu Lieferung, Zahlung und Rücksendung.",
      "Mercato Ticino SA, Via Pretorio 7, 6900 Lugano. Sie erhalten diese E-Mail, weil diese Adresse für die Eröffnung eines Kontos bei Mercato Ticino verwendet wurde. Falls Sie das nicht waren, erhalten Sie keine weiteren Nachrichten. E-Mail-Einstellungen · Datenschutz · AGB",
    ),
  },
];
