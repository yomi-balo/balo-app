import { DEFAULT_BALO_FEE_BPS, formatFeePercent } from '@balo/shared/pricing';
import { PLATFORM_PRICING } from '@/lib/constants/platform';

/**
 * One numbered clause. Its number is derived from its position (see `clauseLabel`), never typed.
 * `text` may contain `{{clause:<id>}}` tokens, which `resolveClauseRefs` replaces with the number
 * of the clause carrying that `id`.
 */
export interface TermsNode {
  /** Required when the clause is referenced by a token, or carries a `draft` marker. */
  id?: string;
  text: string;
  children?: readonly TermsNode[];
  /** A trailing paragraph that renders after the sub-clauses. */
  after?: string;
  /** Drafted for Balo rather than ported from the published terms. The renderer never reads it. */
  draft?: true;
}

export interface TermsSection {
  id: string;
  title: string;
  clauses: readonly TermsNode[];
  /** Drafted for Balo rather than ported from the published terms. The renderer never reads it. */
  draft?: true;
}

/** ISO date the terms were last revised. */
export const EXPERT_TERMS_LAST_UPDATED = '2026-10-12';

const LAST_UPDATED_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

/** `EXPERT_TERMS_LAST_UPDATED` as a long date, e.g. "12 October 2026". */
export const EXPERT_TERMS_LAST_UPDATED_LABEL: string = LAST_UPDATED_FORMAT.format(
  new Date(`${EXPERT_TERMS_LAST_UPDATED}T00:00:00Z`)
);

/** The default Service Fee as a share of the Rate, derived from the platform fee. */
const FEE_ON_TOP = formatFeePercent(DEFAULT_BALO_FEE_BPS);

/** The default Service Fee as a share of the price the User pays. */
const FEE_SHARE_OF_CLIENT_PRICE = PLATFORM_PRICING.SERVICE_FEE_SHARE_LABEL;

export const EXPERT_TERMS_PREAMBLE: readonly string[] = [
  `These Terms and Conditions of Use, which include our Privacy Policy (a copy of which can be accessed at www.balo.expert/privacy) (together "Terms") apply to the website located at www.balo.expert, and all associated web sites, sub-domains, platforms, forums or marketplaces and mobile applications ("Site"). The Site is owned and operated by Balo Technologies Pty Ltd ("Balo Technologies", "our", "us", or "we").`,
  `The site is an online platform that helps to connect consumers ("Users") to Service Providers to facilitate the teaching, demonstrating and offering skills in the use of online platforms (including but not limited to Salesforce). The facilitation of video consultation sessions between Services Providers and Users, the provision of online tools, apps, forums, marketplaces and information to Users and Service Providers by us, and the provision of billing services to enable you to charge Users for access to your services on the Site (each a "Service") are governed not only by these Terms, but also by any service agreement (though often there will not be any other agreement beyond these Terms) in place between you and us in relation to those Services that is applicable to that service or part of the Site. If there is any conflict or inconsistency between the Terms and a service agreement, the service agreement will prevail.`,
  `A "Service Provider" means a person who offers the provision of services and is an expert in that field (such as demonstrations, tutorials, instructions or guidance in a particular skill or area of expertise such as the use and optimization of Salesforce) to Users via the audio and/or video platform offered by the Site, and to complete specific projects requested by Users that are quoted and paid for using the Site ("SP Services"), and who communicates with, or advertises to, Users via the Site. These Terms apply to you in your capacity as a Service Provider. If you are also a User, then our User Terms and Conditions will apply to you in that capacity.`,
  `A "Facilitator" refers to Balo Technologies in its capacity as a provider of software tools, communications infrastructure and payment facilitation, and not as a party to any agreement between Service Providers and Users.`,
  `"User Agreement" means the legally binding contract entered into directly between a User and a Service Provider in relation to SP Services, which may be based on a standardized form supplied by Balo Technologies or otherwise negotiated between the parties.`,
  `If you have any questions about these Terms, please contact us by emailing info@balo.expert`,
];

export const EXPERT_TERMS: readonly TermsSection[] = [
  {
    id: 'acceptance',
    title: 'Acceptance of these Terms',
    clauses: [
      {
        text: `Your use of the Site (including the provision of SP Services) and/or our Services, Subscriptions and its content (including text, images, media, sound, video, social media posts or downloadable documentation and newsletters) is governed by these Terms and all applicable laws and regulations (including any relevant codes of conduct) as amended from time to time. You agree that you will not provide any Services that you are unqualified or unlicensed to provide.`,
      },
      {
        text: `By using the Site, you agree to these Terms; if you do not or cannot agree, you must stop using the Site immediately.`,
      },
      {
        text: `These Terms apply to all uses of the Site including your use of sections of the Site that are subject to additional specific terms and conditions which will apply even if you fail to review those specific terms and conditions.`,
      },
      {
        text: `Service Providers acknowledge and agree that:`,
        children: [
          {
            text: `they are independent contractors and not employees, agents, or partners of Balo Technologies;`,
          },
          {
            text: `they shall be solely responsible for determining the manner and means of providing the SP Services;`,
          },
          {
            text: `they shall be solely responsible for payment of all taxes, insurance, and other expenses related to their business;`,
          },
          {
            text: `nothing in these Terms creates a partnership, joint venture, agency, or employment relationship between Balo Technologies and the Service Provider; and`,
          },
          {
            text: `they have no authority to bind Balo Technologies to any commitment, contract, or course of action.`,
          },
        ],
      },
    ],
  },
  {
    id: 'eligibility',
    title: 'Eligibility to use the Site',
    clauses: [
      {
        text: `Service Providers who use the Site must:`,
        children: [
          { text: `be over the age of 18 (if a natural person);` },
          {
            text: `hold all necessary qualifications, expertise and registrations (if any) necessary to provide their services in the countries in which the Users they provide services to are domiciled; and`,
          },
          {
            text: `not be subject to any disqualification that impacts their ability to provide the SP Services.`,
          },
        ],
      },
      {
        text: `By using the Site after these Terms have been brought to your attention, you warrant that you have authority to bind any organisation you represent to these Terms.`,
      },
    ],
  },
  {
    id: 'marketplace',
    title: 'Balo Technologies Marketplace',
    clauses: [
      {
        text: `The purpose of the Site is to:`,
        children: [
          {
            text: `facilitate the connection of Users to appropriate Service Providers (either by way of a directory listing, searchable database or direct recommendation) for the provision of SP Services;`,
          },
          {
            text: `provide a platform to enable Service Providers to provide the SP Services to Users; and`,
          },
          { text: `provide billing services to Service Providers.` },
        ],
      },
      {
        text: `The Site allows Service Providers to advertise their services (each a "Listing"), and Users to request bookings ("Booking"). Balo Technologies acts solely as a Facilitator that provides a digital platform to enable the listing, booking, communication and credit-based payment for SP Services between Users and Service Providers. Balo Technologies is not a party to any agreement formed between Users and Service Providers, and does not guarantee or warrant the performance of either party. Any contract for services is formed directly between Users and Service Providers.`,
      },
      {
        text: `Any contract formed between a User and a Service Provider constitutes a User Agreement and Balo Technologies shall have no liability in respect of the performance or enforcement of such agreement.`,
      },
      {
        text: `You agree not to ever represent to any third party that you are acting on behalf of Balo Technologies without our prior express written authority.`,
      },
      {
        text: `You acknowledge and agree that you contract independently with each User for SP Services and are solely responsible for the performance of your obligations under such User Agreements.`,
      },
      {
        text: `Notwithstanding this, you warrant that anything you post to the Site is true and accurate to the best of your knowledge.`,
      },
      {
        // Drafted wording, pending legal review: Stripe Connect is replaced with Airwallex for
        // payout and identity collection.
        id: 'marketplace.payout-eligibility',
        draft: true,
        text: `In order to receive payments for SP Services provided, you must either:`,
        children: [
          {
            text: `allow collection of your business identification number (for example, if your business is registered in Australia this will be your Australian Business Number, or if you are registered in the USA this will be your Employer Identification Number) via the Site or via Airwallex (or any other similar payout provider used by Balo Technologies) at the time of your registration or when you set up your payout details; or`,
          },
          {
            text: `upload verifiable evidence confirming that you are not required by law to hold such a business identification number (for example, in Australia this will be a valid 'Statement by Supplier' confirming that you are not required to hold an Australian Business Number).`,
          },
        ],
        after: `In absence of the provision of this, you will not be permitted to receive payment for SP Services via the Site.`,
      },
      {
        text: `Where you charge fees through the Site, Balo Technologies acts as your disclosed agent, and you will be liable for any cost, loss or damage arising from:`,
        children: [
          {
            text: `third party costs, fees, penalties or charges (including bank or merchant fees) arising from your use of the Site or any refund claims;`,
          },
          { text: `incorrect banking details being submitted;` },
          { text: `User claims for refunds;` },
          { text: `fraud or misuse of your Balo Account.` },
        ],
      },
      {
        text: `Balo Technologies reserves the right to modify, hide or remove Listings without notice and without the need to provide reasons for doing so.`,
      },
      {
        text: `You may be asked to provide details of:`,
        children: [
          { text: `your availability to accept bookings;` },
          { text: `the types and lengths of bookings you are willing to accept;` },
          { text: `the expertise and qualifications you hold; and` },
          { text: `the skills you are able to offer.` },
        ],
      },
      {
        text: `You agree that you will keep the Listing updated to ensure that all details entered by you are accurate and current.`,
      },
      {
        text: `We rely upon the accuracy of your availability as communicated to us. If you cannot service a Booking that has been requested, you must inform the relevant User as soon as reasonably possible via the Site chat function, or if that function is unavailable, any other appropriate means of communication. We will endeavour to reschedule the Booking, but if a User receives a refund due to not wishing to have their Booking rescheduled, you agree to indemnify us from any loss or damage arising from that refund (including by paying any merchant or third party costs we incur in relation to that Booking).`,
      },
      {
        text: `Balo Technologies may, but is not obliged to, charge a cancellation or 'no show' fee to Users who cancel or do not attend a scheduled appointment. If Balo Technologies' does charge a 'no show' fee a portion of this will be paid to the Service Provider, less Balo Technologies' fees, and any third party transaction or currency conversion fees.`,
      },
      {
        text: `Balo Technologies does not endorse, support or confirm the quality or appropriateness of the SP Services provided by a particular Service Provider, beyond the extent to which it has vetted the Service Provider to ensure they are highly skilled, have sufficient experience and suitable references. Balo Technologies is not responsible for any consequences resulting from false or misleading information provided by a Service Provider. Any information contained in a Listing is not intended to replace consultation with a qualified professional, and you must ensure that anything you say to a User or submit to a Listing is accurate and does not represent otherwise.`,
      },
      {
        id: 'marketplace.off-platform',
        text: `It is a condition of your use of the Site that you only provide SP Services to Users via the Site. You agree not to contact, approach or engage with Users outside of the Site in any way connected to the SP Services or services of a similar type or kind offered by Service Providers on the Site (regardless of whether you offer services of those types or kinds via the Site). For the avoidance of doubt, this does not prevent Service Providers from offering their services to individuals not introduced to them via the Site outside of the Site, nor does it prohibit Service Providers from entering into ongoing long term arrangements that are of a kind unable to be facilitated on the Site. If you have a concern as to whether a particular engagement is permitted to occur outside of the Site, please contact us for clarification.`,
      },
      {
        text: `You acknowledge that any attempt to communicate with, or provide services to, Users outside the Site as prohibited by clause {{clause:marketplace.off-platform}} would cause loss and damage to Balo Technologies and agree that you will not seek to induce, or else agree with a User to provide services of a kind the same as, or similar to, SP Services as prohibited by clause {{clause:marketplace.off-platform}} without Balo Technologies' prior written consent (which may be refused in Balo Technologies' absolute discretion).`,
      },
      {
        text: `You indemnify Balo Technologies from the reasonable costs (including legal fees on a solicitor/client basis), loss or damage arising from your communicating with a User outside of the Site.`,
      },
    ],
  },
  {
    id: 'services',
    title: 'Services',
    clauses: [
      {
        text: `Access to our Services or Subscriptions will require you to create an account ("Balo Account"). When you create a Balo Account, we will collect certain information from you that is necessary to create your Balo Account. We will use and disclose this information in accordance with our Privacy Policy. You must ensure that all information provided to us is accurate and remains up to date at all times.`,
      },
      {
        text: `We make no warranty or representation that information provided by Users is accurate, nor that they are able and willing to make payment for services they seek to acquire from you. You agree, to the extent permitted by law, to hold Balo Technologies, its officers, agents and employees harmless from any loss or damage you suffer due to a User failing to make payment or seeking a credit card chargeback in relation to a payment facilitated by Balo Technologies and/or our merchant gateway provider.`,
      },
      {
        id: 'services.licence',
        text: `As long as you comply with these Terms, we grant you (as a Service Provider) a personal, non-exclusive, non-transferable, revokable, limited licence to access and use the Site to the extent necessary to offer and provide SP Services to Users.`,
      },
      {
        text: `We do not guarantee that the Site:`,
        children: [
          { text: `will be accessible or functional (whether wholly or partly) at all times; or` },
          {
            text: `is free from viruses or anything else which may damage any computer which accesses our Site or any data on such a computer.`,
          },
        ],
      },
      {
        text: `You are responsible for configuring the technology you use to access our Site. You should use your own virus protection software.`,
      },
      {
        text: `Balo Technologies does not verify the credentials of Users nor guarantees their payment behaviour. You acknowledge that you bear the full commercial risk of dealings with Users and agree that Balo Technologies is not liable for any default, misrepresentation, non-payment, or unlawful act by any User.`,
      },
      {
        text: `We may suspend or withdraw or restrict the availability of all or any part of our Site for business, operational or any other reason at any time. We will ordinarily try to give you reasonable notice of any suspension or withdrawal (but are not required to do so).`,
      },
      {
        text: `You are also responsible for ensuring that all persons who access our Site through your internet connection are aware of these Terms and other applicable terms and conditions, and that they comply with them.`,
      },
      {
        text: `By holding a Balo Account and providing personal information to us, you consent, and (where relevant) represent that where you provide personal information that relates to another person, that person has consented, to the collection, use, storage, disclosure and other handling of that information as described in these Terms and our Privacy Policy. You agree to provide us with evidence of that consent on reasonable notice.`,
      },
      {
        text: `We may also ask you to consent to additional activities in relation to your personal information from time to time. You can choose to grant or withhold this additional consent without affecting your normal use of the Site.`,
      },
    ],
  },
  {
    id: 'referrals',
    title: 'Referrals',
    clauses: [
      {
        text: `If a User books a SP Service with you and you wish to refer the User to another Service Provider who you believe is more qualified or appropriate to provide the SP Service, you may elect to do so by:`,
        children: [
          {
            text: `adding the email address of other Service Providers during the application process or via any invitation links found on the Site.`,
          },
        ],
      },
    ],
  },
  {
    id: 'material',
    title: 'Service Provider Material',
    clauses: [
      {
        text: `The Service Provider, on its Listing or in its other interactions on the Site (including in the video content uploaded during the provision of SP Services and in private chats), may provide, post or otherwise make available information, material or other content ("Service Provider Material").`,
      },
      {
        text: `As between us (and in respect of any other user of the Site), you have full responsibility and liability for Service Provider Material (including any Service Provider Material which is originally created or owned by a third party).`,
      },
      {
        text: `As a Service Provider, you must ensure at all times that:`,
        children: [
          {
            text: `the Service Provider Material is:`,
            children: [
              {
                text: `accurate, complete and up to date at all times (and you acknowledge that Balo Technologies and Users of the Site may be reliant on the accuracy and completeness of such Service Provider Material);`,
              },
              {
                text: `free from errors, and to the extent reasonably possible takes into account the needs and circumstances of Users; and`,
              },
              {
                text: `free from viruses and malicious code and does not, and your use of the Site does not, impair the functionality of the Site or the operations of Balo Technologies or any other user of the Site;`,
              },
            ],
          },
          {
            text: `you have all necessary rights, and appropriate licences and adequate insurances (if any) to supply and use Service Provider Material in connection with the Site. From time to time Balo Technologies may require you to obtain a form of insurance as a condition of your registration as a Service Provider. If we do, you will be given a minimum of 30 days to source such insurance and provide Balo Technologies with proof of cover. A failure to provide such proof will result in your registration as a Service Provider being revoked;`,
          },
          {
            text: `you are suitably qualified to provide any advice or information contained within the Service Provider Material and SP Services;`,
          },
          {
            text: `the Service Provider Material and SP Services do not include any material (including any misleading material) which may reasonably be expected to:`,
            children: [
              {
                text: `expose Balo Technologies or its affiliates to reputational, regulatory or financial risk;`,
              },
              {
                text: `present a Work, Health and Safety risk to any personnel (including contractors) of Balo Technologies or its affiliates. This extends to and covers any verbal or written abuse;`,
              },
              {
                text: `be contrary to, or cause Balo Technologies to breach any law or regulation applicable to Balo Technologies or the Site; and`,
              },
            ],
          },
          {
            text: `you will ensure that all Service Provider Material complies with the requirements of these Terms, including prohibitions on posting offensive material or restrictions on advertising your business; and`,
          },
          {
            text: `all material you post (including Service Provider Material) must comply with all relevant legislation and professional standards.`,
          },
        ],
      },
    ],
  },
  {
    id: 'security',
    title: 'Passwords and Security',
    clauses: [
      {
        text: `When you register and activate your Balo Account with us, you can choose your username and password. You are responsible for maintaining the confidentiality of the information used to access your Balo Account, including your password, and for any and all activity that occurs under your Balo Account as a result of your failing to keep this information secure and confidential. Individual Service Providers within a larger business should create individual Balo Accounts, and not use a single Balo Account across an organisation.`,
      },
      {
        text: `You agree to notify us immediately of any unauthorised use of your Balo Account or password, or any other breach of security. You may be held liable for losses incurred by us or any other user of or visitor to the Site due to someone else using your Balo Account profile, password or Balo Account as a result of your failing to keep your account information secure and confidential.`,
      },
      {
        text: `You may not use anyone else's Balo Account profile, password or Balo Account at any time without the express permission and consent of the holder of that account profile, password or account. We cannot and will not be liable for any loss or damage arising from your failure to comply with these obligations.`,
      },
    ],
  },
  {
    // Drafted wording, pending legal review: this section is redrafted for the take-home Rate,
    // with the Service Fee added on top and paid by the User, the per-engagement fee, and Airwallex
    // payouts. Clause 8.8.3 keeps the 23 July 2025 payout schedule pending confirmation from MJ
    // (the ticket says TBC). There is no RCTI clause until the accountant confirms. Clause 8.8.1
    // keeps the old set-off of transaction and currency conversion fees and needs confirming.
    // Clauses 8.9, 8.10 and 8.11 are retained verbatim.
    id: 'fees',
    title: 'Fees',
    draft: true,
    clauses: [
      {
        text: `You set the rate you charge Users for your SP Services on the Site (your "Rate"). Your Rate is the amount you receive for your SP Services. Balo Technologies does not deduct its fees from your Rate.`,
      },
      {
        id: 'fees.service-fee',
        text: `In return for hosting a Listing and facilitating the provision of SP Services on the Site, Balo Technologies charges Users a service fee that is added on top of your Rate ("Service Fee"). The Service Fee is paid by the User, not by you. By default, the Service Fee is ${FEE_ON_TOP} of your Rate, which is ${FEE_SHARE_OF_CLIENT_PRICE} of the price the User pays.`,
      },
      {
        text: `SP Services are paid for on the Site as follows:`,
        children: [
          {
            text: `consultations booked as cases ("Cases") are billed per minute at your Rate plus the Service Fee, from credit the User has prepaid on the Site;`,
          },
          {
            text: `projects quoted and agreed on the Site ("Projects") are paid against the milestones set out in the statement of work agreed between you and the User; and`,
          },
          {
            text: `productised services offered at a fixed price ("Packages") are paid at that fixed price, plus the Service Fee.`,
          },
        ],
      },
      {
        text: `The Service Fee in clause {{clause:fees.service-fee}} is a default and may differ between engagements. Balo Technologies may set a different Service Fee for a particular engagement (for example, a particular Project), and the Service Fee that applies to each Case session is recorded when that session opens. A different Service Fee changes the price the User pays for that engagement. It does not change your Rate.`,
      },
      {
        text: `Balo Technologies does not currently charge Service Providers any fee for hosting a Listing. Balo Technologies may, by written notice to you, introduce a monthly recurring fee ("Subscription Fee") for the hosting of a Listing and provision of Services during a time limited period ("Subscription"). Subscriptions will run for the period stated at the time of you purchasing the Subscription but will generally consist of monthly periods (each a "Subscription Period"). We may, from time to time, offer a discount if you choose to purchase a Subscription Period of a longer duration (such as an annual Subscription). Such discounts are offered at our absolute discretion and may be withdrawn by us at any time. The Service Fee and any Subscription Fee are together the "Fees".`,
      },
      {
        text: `The amount of Fees may be amended by us from time to time by written notice to you. Any change in Subscription Fee will only impact subscription periods commencing after that notice is given, and any change to the default Service Fee will only impact SP Services provided after notice of the change has been given.`,
      },
      {
        text: `If we introduce a Subscription Fee:`,
        children: [
          {
            text: `it is payable on the due date indicated in the invoice issued by us, in full and in cleared funds, and in Australian dollars unless otherwise indicated;`,
          },
          {
            text: `you agree to pay it using a valid credit card (or other form of payment as we may allow from time to time) without set off, abatement or deduction, and it will be automatically debited from your nominated card when it falls due for payment;`,
          },
          {
            text: `you agree to provide us with current and complete information as required for payment (which may include full legal name, email address, credit card details and billing information);`,
          },
          {
            text: `if you are charged an incorrect amount due to an error or malfunction, we are entitled to recover from you the correct amount, even if we have already taken payment from you of the incorrect amount; and`,
          },
          {
            text: `if your Subscription Fee payment is declined (for example, because of incorrect payment details or insufficient funds) we may cancel or suspend your Balo Account and access to the Site and Services until payment has been received. You remain responsible for any outstanding payments owing to us and you authorise us to charge any outstanding payments to your updated payment method.`,
          },
        ],
      },
      {
        text: `Where we have collected funds from Users in relation to your provision of SP Services, we will:`,
        children: [
          {
            text: `retain the Service Fee paid by the User, and set-off any outstanding Subscription Fee and any third party transaction or currency conversion fees;`,
          },
          {
            text: `provide you with a statement of the amounts collected, retained and set off; and`,
          },
          {
            id: 'fees.payout-schedule',
            text: `remit the funds to you via Airwallex (or any other similar payout provider used by Balo Technologies) on the sooner of the first business day in Victoria, Australia following the 1st or 15th of each month.`,
          },
        ],
      },
      {
        id: 'fees.gst',
        text: `You acknowledge that all amounts payable under or in connection with our Services are expressed on a tax-inclusive basis unless explicitly stated otherwise. If any tax is applicable under these Terms, the User must pay an additional amount equal to the amount of tax that is payable. For example, if you are located in Australia and are required to pay GST then you acknowledge that all amounts payable under or in connection with our Services are expressed on a GST-inclusive basis unless explicitly stated otherwise. Words or expressions used in this clause {{clause:fees.gst}} which are defined in the GST Law have the same meaning in this clause. If any supply made in accordance with these Terms is a taxable supply, the recipient must pay to the supplier, in respect of that taxable supply, an additional amount equal to the GST payable by the supplier in respect of that taxable supply. In this clause {{clause:fees.gst}} "GST Law" means A New Tax System (Goods and Services Tax) Act 1999 as amended or replaced from time to time and also includes any associated legislation and delegated legislation.`,
      },
      {
        text: `You acknowledge and agree that:`,
        children: [
          {
            text: `you are solely responsible for determining, collecting, reporting, and remitting all applicable taxes, duties, levies, and imposts of any kind (including but not limited to value-added tax, goods and services tax, sales tax, income tax, and withholding tax) in connection with your provision of SP Services through the Site;`,
          },
          {
            text: `any fees you charge for SP Services must be inclusive of all applicable taxes, and you must clearly incorporate these taxes into your pricing when creating Listings or quoting for Projects;`,
          },
          {
            text: `you are responsible for providing valid tax invoices or receipts to Users in accordance with applicable laws in your jurisdiction;`,
          },
          {
            text: `you shall maintain appropriate records for tax compliance purposes and provide such records to relevant tax authorities as required;`,
          },
          {
            text: `you shall be solely responsible for all income taxes, corporate taxes, payroll taxes, social security contributions, superannuation, workers compensation contributions, and any other taxes, duties, levies, or charges applicable to your business activities and income derived from the provision of SP Services; and`,
          },
          {
            text: `Balo Technologies is not responsible for providing tax advice or determining your tax obligations in any jurisdiction.`,
          },
        ],
      },
      {
        text: `Where any indemnity, reimbursement or similar payment under these Terms is based on any cost, expense or other liability, it shall be reduced by any input tax credit entitlement in relation to the relevant cost, expense or other liability.`,
      },
    ],
  },
  {
    // Drafted wording, pending legal review: credits-per-minute pricing is replaced with the
    // expert's Rate, and Stripe Connect with Airwallex. No client-charging vendor is named.
    // Clause 9.5 has one grammar fix (adds "of").
    id: 'payment-by-user',
    title: 'Payment by User',
    draft: true,
    clauses: [
      {
        text: `To purchase SP Services, Users buy credits on the Site through our payment processor.`,
      },
      {
        text: `When you post a Listing on the Site for an SP Service, you set your Rate for that SP Service. Users pay the price shown on the Site, which is your Rate plus the Service Fee. Balo Technologies may from time to time set a maximum or minimum Rate you may charge for a particular SP Service by notice to you in writing, or by enforcing a technical limitation on the Site.`,
      },
      {
        text: `Amounts you earn will be converted to your chosen currency (provided it is a currency that Balo Technologies have agreed to make payment in) at the conversion rates at the time of transaction using rates determined by the payment solutions used by Balo Technologies.`,
      },
      {
        text: `You must set up the ability to receive funds referable to the SP Services you have provided, which are held in escrow by Balo Technologies, by setting up your payout details with Airwallex (or any other similar payout provider used by Balo Technologies at the time). Funds will then be transferred to your nominated bank account via Airwallex in accordance with clause {{clause:fees.payout-schedule}}.`,
      },
      {
        text: `Balo Technologies may impose a minimum payment amount such that Balo Technologies will not be obliged to make payment of fees paid to Balo Technologies for SP Services provided by you unless those fees reach and/or exceed the minimum payment amount set by Balo Technologies.`,
      },
    ],
  },
  {
    id: 'cancellation',
    title: 'Cancellation and Suspension',
    clauses: [
      {
        text: `You may cancel or suspend your Balo Account at any time through your account settings. When you cancel or suspend your Balo Account, you will no longer be entitled to access or utilise the Services or Subscriptions until we re-activate your Balo Account.`,
      },
      {
        text: `You may terminate your Balo Account if we are in breach of a material term of these Terms, and we fail to remedy that breach within 28 days' of receiving written notice to remedy such breach.`,
      },
      {
        text: `We may immediately suspend or remove you as a Service Provider if:`,
        children: [
          {
            text: `you are, or we reasonably suspect that you are or may be in breach of these Terms or any applicable law or regulation;`,
          },
          {
            text: `you cease to hold a relevant licence or qualification (if any) required to provide SP Services, or we form the view that you do not hold the expertise or experience you have claimed to possess;`,
          },
          {
            text: `you are adjudicated bankrupt, enter into liquidation or any arrangement or composition with your creditors or if a receiver is appointed to any part of your assets and not discharged within 14 days or if any judgment against you remains unsatisfied for more than 7 days;`,
          },
          {
            text: `we reasonably believe that Balo Technologies or our affiliates are, or are likely to be, in breach of law or brought into disrepute, as a result of the provision of, or your use of, the Services or Subscriptions;`,
          },
          {
            text: `we are required to do so in order to comply with an order, instruction or request of a regulatory authority or agency; or`,
          },
          { text: `we have a reasonable belief that you are in breach of any applicable law.` },
        ],
      },
      {
        text: `We will not be responsible for any loss, cost, damage or liability that may arise as a result of our cancellation or suspension of your Balo Account or access to the Site or other Services or Subscriptions.`,
      },
      {
        id: 'cancellation.without-cause',
        text: `We may cancel or suspend, for any or no reason:`,
        children: [
          { text: `your Listing immediately; or` },
          {
            text: `your access to your Balo Account and/or the Services or Subscriptions with a minimum of 7 days' notice to you.`,
          },
        ],
      },
      {
        text: `If your Balo Account is cancelled or these Terms are otherwise terminated or expire:`,
        children: [
          {
            text: `the licence granted by Balo Technologies to you under clause {{clause:services.licence}} will cease and we shall cease providing (and you shall cease using) the Site, Services or Subscriptions and any content;`,
          },
          {
            text: `you must (at our request) return or destroy all copies of confidential information retained in your systems or otherwise in your possession or control;`,
          },
          {
            text: `we may in our discretion, delete any data, content or materials which have been provided us in connection with your Balo Account, including the Service Provider Material, provided that we shall use reasonable endeavours to give you 7 days to download such data, content or materials prior to deletion; and`,
          },
          {
            text: `this will not affect any accrued rights, and rights and obligations which are intended or which by their nature survive termination will continue to have effect.`,
          },
        ],
      },
      {
        text: `If:`,
        children: [
          {
            text: `we cancel your Balo Account without cause pursuant to clause {{clause:cancellation.without-cause}}; or`,
          },
          {
            text: `you terminate your agreement with us due to our breach of these Terms, you will be entitled to a pro-rata refund of any Subscription Fees paid that extend beyond the date of termination, if applicable.`,
          },
        ],
      },
    ],
  },
  {
    id: 'confidentiality',
    title: 'Confidentiality and Data Protection',
    clauses: [
      {
        text: `You acknowledge that in the course of providing SP Services to Users, you may have access to personal information of Users. You agree to:`,
        children: [
          { text: `Keep all such information strictly confidential;` },
          { text: `not disclose the information to any third parties;` },
          {
            text: `use and/or process the information only to the extent required to deliver the SP Services;`,
          },
          {
            text: `implement and maintain appropriate technical and organisational measures to protect the information from unauthorised or unlawful processing, accidental loss, destruction or damage;`,
          },
          { text: `comply with all applicable data protection and privacy laws;` },
          {
            text: `promptly delete or anonymise personal information when it is no longer required; and`,
          },
          {
            text: `not retain any such information for longer than necessary to provide the SP Services.`,
          },
        ],
      },
      {
        text: `Service Provider agrees to indemnify Balo Technologies for any claim, loss or penalty arising from a breach of your data protection obligations.`,
      },
      {
        text: `Service Providers acknowledge that any breach of these confidentiality obligations may cause significant harm to Users and Balo Technologies, and may result in termination of your Balo Account and legal action.`,
      },
    ],
  },
  {
    // Drafted wording, pending legal review: this clause is new. Confirm whether 12.2.3 (platform
    // improvement) is meant to cover training general-purpose models. Training an AI agent on an
    // expert's sessions needs separate opt-in consent (12.4).
    id: 'recording',
    title: 'Recording, Transcription and AI',
    draft: true,
    clauses: [
      {
        text: `Sessions held on the Site (including video consultation sessions) may be recorded and transcribed. Participants are told before recording starts.`,
      },
      {
        text: `In accordance with our Privacy Policy, Balo Technologies may use recordings and transcripts of sessions:`,
        children: [
          {
            text: `to deliver the Services, including preparing summaries and recaps of sessions for you and the relevant User;`,
          },
          {
            text: `to facilitate the resolution of disputes, including under clause {{clause:disputes}}; and`,
          },
          { text: `to maintain and improve the Site and the Services.` },
        ],
      },
      {
        text: `By accepting these Terms, you consent to sessions in which you participate on the Site being recorded, transcribed and used as described in this clause {{clause:recording}}. Recordings and transcripts may contain personal information of Users, and clause {{clause:confidentiality}} applies to any such information you access.`,
      },
      {
        text: `Balo Technologies may in future offer features that train an artificial intelligence agent on a Service Provider's sessions, knowledge or likeness (including their voice and image). We will not use your sessions, recordings, transcripts or likeness to train such an agent unless you give separate, express, opt-in consent for that purpose. No such consent is given or implied by your acceptance of these Terms, and you can choose to grant or withhold it without affecting your normal use of the Site.`,
      },
    ],
  },
  {
    id: 'privacy',
    title: 'Privacy',
    clauses: [
      {
        text: `These Terms incorporate our Privacy Policy and you are taken to have read and accepted that policy. By using the Service, you consent to the processing of your personal information described in our Privacy Policy, and warrant that all information and data provided by you is accurate.`,
      },
    ],
  },
  {
    id: 'inappropriate-use',
    title: 'Inappropriate use and content',
    clauses: [
      {
        text: `Except as otherwise specified in these Terms, you may not modify, copy, distribute, transmit, display, perform, reproduce, publish, license, commercially exploit, create derivative works from, transfer, or sell any content, software, products or services contained within the Site (including any Service or Subscriptions).`,
      },
      {
        text: `You agree to follow all policies and guidelines made available to you by us at all times when you are using the Site. You acknowledge that we, and any moderator we engage, can access and review all information you post to the Site.`,
      },
      {
        text: `You acknowledge that we, and any moderator we engage, may undertake certain actions, at our sole discretion, where we consider there has been unacceptable activity we may take the following action:`,
        children: [
          { text: `contact you directly and/or issuing a warning;` },
          {
            text: `immediately remove, hide or edit information or documents posted to the Site, or move a post to a more appropriate section of the Site without notification;`,
          },
          {
            text: `terminate or temporarily suspend access to your Balo Account, or your ability to publicly post on the Site upon reasonable notice to you where practicable; or`,
          },
          { text: `report the activity to law enforcement, regulators or other authorities.` },
        ],
      },
      {
        text: `You must not use the Site to send unsolicited communications to recipients who have not given you permission to send them such communication. You must not publish any defamatory, offensive, illegal or inappropriate material or any material which infringes a third party's intellectual property rights or which contains a virus, worm, Trojan horse or other code that manifests contaminating or destructive properties. For the avoidance of doubt, 'publish' includes sending private communications to a third person. You must not attempt to modify or damage the Site and you must not use or target the Site in connection with a denial of service attack. You must not impersonate any person or entity or enter a fictitious name or purport to be authorised to represent any person or entity if not authorised to do so. You must not cause or permit any other person to engage in any of these activities (e.g. by providing them with access to your computer or by providing password information to them). You must not make use of information or content on the site for any purpose other than offering and providing services to Users or information to Users. You must not collect, use or disclose personal information about Users without their prior consent and always must do so in accordance with the provisions of the Privacy Act 1988 (Cth) and our Privacy Policy. You are not permitted to discuss matters that are the subject of legal action or threatened litigation.`,
      },
      {
        text: `You must not use information collected from the Site or Users to produce a product, service or other enterprise that competes directly or indirectly with Balo Technologies and the Site.`,
      },
      {
        id: 'inappropriate-use.unlawful-content',
        text: `If you become aware of any content that you believe to be unlawful or defamatory, you agree to notify us as soon as practicable. Balo Technologies will assess and remove that content within 7 days. To the extent permitted by law, you agree that we are not responsible for content posted by third parties provided we have complied with this clause {{clause:inappropriate-use.unlawful-content}}.`,
      },
    ],
  },
  {
    id: 'warranty',
    title: 'Warranty',
    clauses: [
      {
        text: `You warrant that you will keep your credentials required to login to the Site confidential and will make all reasonable efforts necessary to ensure your credentials are not shared with any other person.`,
      },
      {
        text: `As a Service Provider, by posting a Listing and offering to provide a SP Service to a User and providing that service, you warrant that:`,
        children: [
          {
            text: `all information you provide is complete and accurate including its legality, reliability, accuracy and appropriateness;`,
          },
          {
            text: `you are appropriately qualified to provide the SP Service and hold a current and verifiable business identification number (where applicable), all relevant licences and other registrations you are required to hold and maintain in order to offer the SP Services;`,
          },
          {
            text: `your services do not infringe any patent, trade mark, trade secret, copyright or other intellectual property or other rights of any other person;`,
          },
          {
            text: `you have not and will not breach any law in describing or providing the products services you offer to provide on the Site;`,
          },
          {
            text: `you have completed your own due diligence to determine that the User has the capacity to pay the required fees; and`,
          },
          {
            text: `you understand and agree that Balo Technologies has made no assertion or warranty as to the capacity of a User to pay the required fees, and that Balo Technologies will not be a party to any agreement you enter into with a User.`,
          },
        ],
      },
      {
        text: `Service Providers must not use our Services or Subscriptions:`,
        children: [
          { text: `in any way other than in accordance with our Terms;` },
          {
            text: `in any way that violates any applicable federal, state, local or international law or regulation (including, without limitation, any laws regarding the export of data or software to and from other countries);`,
          },
          {
            text: `for the purpose of exploiting, harming or attempting to exploit or harm Users of the Site in any way by exposing them to inappropriate content, asking for personally identifiable information or otherwise;`,
          },
          {
            text: `to transmit, or procure the sending of, any advertising or promotional material including any "junk mail", "chain letter" or "spam" or any other similar solicitation;`,
          },
          {
            text: `to impersonate or attempt to impersonate us, any of our employees, another user or any other person or entity (including, without limitation, by using email addresses or screen names associated with any of the foregoing); or`,
          },
          {
            text: `to engage in any other conduct that restricts or inhibits anyone's use or enjoyment of the Site, or which, as determined by us, may harm us or Users of the Site or expose them to liability.`,
          },
        ],
      },
      {
        text: `You acknowledge and agree that Users are receiving advice and services at their own risk. You shall clearly communicate to Users that:`,
        children: [
          {
            text: `any advice or services provided by you are subject to limitations and uncertainties;`,
          },
          { text: `outcomes cannot be guaranteed;` },
          { text: `Users should exercise their own judgment before implementing any advice; and` },
          {
            text: `Users should seek independent professional advice where appropriate before making significant decisions based on your SP Services.`,
          },
        ],
      },
    ],
  },
  {
    id: 'exclusivity',
    title: 'Platform Exclusivity and Communication',
    clauses: [
      {
        text: `Service Providers must not circumvent the Platform or solicit Users for off-platform engagements that are substantially similar to SP Services. Doing so constitutes a material breach of these Terms.`,
      },
      {
        text: `Any direct arrangement with a User outside the Platform must be pre-approved by Balo Technologies in writing.`,
      },
      {
        text: `Breach of this clause entitles Balo Technologies to suspend or terminate the Service Provider's Balo Account and seek legal redress.`,
      },
    ],
  },
  {
    id: 'multiple-providers',
    title: 'Special Terms for businesses with multiple providers',
    clauses: [
      {
        text: `The terms of this clause {{clause:multiple-providers}} apply where a Service Provider is a business that employs or is otherwise comprised of multiple individuals who will provide SP Services via the Site ("Business Provider").`,
      },
      {
        id: 'multiple-providers.warranties',
        text: `As a Business Provider you warrant that:`,
        children: [
          {
            text: `any person who provides SP Services via the Site is appropriately qualified to offer those services;`,
          },
          {
            text: `you will be required to provide all equipment and technology necessary for those individuals to provide the SP Services other than the Site;`,
          },
          {
            text: `you are responsible, and will be making payment of, all applicable fees, superannuation, workers compensation contributions, taxes or levies relating to the engagement of that individual in providing the SP Services; and`,
          },
          {
            text: `there is no legal reason to prevent the individual from providing the SP Services.`,
          },
        ],
      },
      {
        text: `You indemnify Balo Technologies, its officers, employees and agents from any liability howsoever arising from a breach of the warranties given in clause {{clause:multiple-providers.warranties}}.`,
      },
      {
        text: `Nothing in these Terms and Conditions is intended to create a legal relationship between Balo Technologies and a person employed or engaged by a Business Provider who delivers SP Services.`,
      },
    ],
  },
  {
    id: 'indemnity',
    title: 'Indemnity',
    clauses: [
      {
        text: `By offering to provide services to a User the Service Provider agrees to:`,
        children: [
          {
            text: `indemnify Balo Technologies from any costs, loss or damage (including legal costs on a solicitor/client basis) arising from the publication of any content you publish on the Site, provision of services to Users, any breach of warranty, and/or any act or omission in connection with your use of the Site or provision of the SP Services including, without limitation, any claim arising from the User Agreement, the conduct or omission of a User, or the misuse or unauthorized disclosure of personal information; and`,
          },
          {
            text: `release, hold harmless and indemnify Balo Technologies from any claims, demands and damages (actual and consequential) of every kind and nature, known and unknown, arising out of or in any way connected to your provision or proposed (or intended) provision of services to a User, regardless of whether the provision was facilitated by the Site or not (noting that Balo Technologies will not be a party to any relationship formed by virtue of the provision or offer of those services). This release and indemnity will be reduced to the extent that Balo Technologies' negligence or wilful misconduct contributed to the loss or damage it suffered.`,
          },
        ],
      },
    ],
  },
  {
    id: 'liability',
    title: 'Liability arising from use of the Site and Provision of SP Services',
    clauses: [
      {
        text: `Balo Technologies provides the Site and associated functionalities as a Facilitator. It does not warrant the suitability, conduct or competence of Users or Service Providers.`,
      },
      {
        text: `Subject to any non-excludable rights: (a) your use of the Site and provision of SP Services is entirely at your own risk; (b) you hereby release us from any claims you would otherwise have against us now or in future arising directly or indirectly from the Site or your use of the Site; and (c) in no event will we be liable for any damages whatsoever (including, without limitation, direct, indirect, punitive, special, consequential damages, lost profits, lost data or business interruption) arising out of the use, inability to use, or the results of use of the Site, or arising from your inability to participate in any promotion offered on the Site whether based on contract, tort, statute, common law, equity or any other legal theory and whether or not advised of the possibility of such damages, including any dispute or dissatisfaction with SP Services performed by a Service Provider or any breach of the User Agreement. Without limitation, this exclusion of liability applies to any loss or damage caused by any deficiency in the Site's performance and any error, omission, interruption, deletion, defect, delay in operation or transmission, computer virus, communication line failure, theft or destruction or unauthorised access to, alteration of, or use of any material associated with the Site or your attempted use of the Site.`,
      },
      {
        text: `If you are entitled to make any claim against us as a result of non-excludable rights or on any other basis notwithstanding the provisions of these Terms, our liability to you for the aggregate of such claims (regardless of the basis on which you are entitled to claim from us) is limited to the provision of the information, products or Services or Subscriptions again or payment of the cost of providing the information, products or Services or Subscriptions again (at our election).`,
      },
    ],
  },
  {
    id: 'third-party-material',
    title: 'Third party material',
    clauses: [
      {
        text: `The Site may include content or references supplied by users or other third parties ("third party material"). We do not monitor and accept no liability for third party material. Any opinions, advice, statements, services, offers or other information contained in third party material, is the responsibility of the respective author(s), distributor(s) or providers of that third party material. We make no representation and give no endorsement of the accuracy, adequacy, currency, suitability, completeness, legality, reliability or usefulness of any third party material or the identity, knowledge or qualifications of any provider of third party material. Your access to and reliance on third party material is entirely at your own risk.`,
      },
      {
        text: `References in third party material to any specific products, process, or service by trade name, trademark, manufacturer, or otherwise, do not constitute or imply their sponsorship, endorsement or recommendation by us, and such references shall not be used for advertising or product endorsement purposes.`,
      },
    ],
  },
  {
    id: 'links-out',
    title: 'Links to third party web sites',
    clauses: [
      {
        text: `Any links to third party web sites from the Site are provided solely as a convenience to you. We make no representation as to the intellectual property rights of any material available on the linked third party web sites or your rights to access, reproduce and use that material. We do not review or monitor any linked third party web sites and we are not responsible for the accuracy, adequacy, currency, suitability, completeness, legality, reliability or usefulness of any third party material on the Site or material on any third party web site and accept no responsibility for any broken or redirected links. The presence of such links should not be taken to imply any type of association, sponsorship, endorsement, monitoring, approval of, or responsibility for, the linked third party web site or its content. It is your responsibility to evaluate the content and usefulness of information obtained from other web sites. Your access to and reliance on any third party web site is entirely at your own risk.`,
      },
      {
        text: `You acknowledge and agree that we may receive payments or other benefits in connection with links to third party web sites or the inclusion of third party material in the web sites.`,
      },
    ],
  },
  {
    id: 'links-in',
    title: 'Links from other web sites to the Site',
    clauses: [
      {
        text: `Other web sites may only link to the Site with our prior written permission. Any web site that links to the Site must link to the relevant home page and must not: (a) replicate the Site's content; (b) create a browser or border environment around the Site's content; (c) imply any endorsement by us; (d) misrepresent its relationship with us; (e) present false information about our Services or Subscriptions; or (f) use our name or logos without our prior written permission.`,
      },
    ],
  },
  {
    id: 'intellectual-property',
    title: 'Content and Intellectual Property Rights',
    clauses: [
      {
        text: `We are the owner or the licensee of all Intellectual Property in the Site and its content and our Services or Subscriptions (unless expressed to the contrary).`,
      },
      {
        text: `Title and ownership of our Intellectual Property shall not be transferred by virtue of your use of the Site or our Services or Subscriptions.`,
      },
      {
        text: `Where you upload information and data to our Site, you:`,
        children: [
          { text: `warrant that you have a right to provide us with that information and data;` },
          {
            text: `warrant that our storage and processing of that information and data will not infringe any third party's legal rights; and`,
          },
          {
            text: `grant us and our affiliated companies a perpetual, royalty-free, world-wide, assignable and sub-licencable licence to use that information and data for the purpose of providing you, and our Users with our Services, Subscriptions and content, and for our own internal purposes.`,
          },
        ],
      },
      {
        text: `Unless specifically authorised by us, or otherwise allowed by applicable laws, you may not copy, modify, publish, transmit, transfer or sell, reproduce, create derivative works from, distribute, perform, display, or in any way exploit any of the Content or our Site, in whole or in part.`,
      },
      {
        text: `You agree that you will not seek to reverse engineer, decompile or otherwise reproduce the Site or any of our Services, Subscriptions or content.`,
      },
      {
        text: `You must not use our name, all related names, logos or trade marks, or the trade marks of our affiliates or licensors without our prior written consent.`,
      },
      {
        text: `You agree to not offer our Services, Subscriptions or content for resale to any third party.`,
      },
      {
        text: `If we provide social media features such as the ability to share our content, you may take such actions as are enabled by such features but only using such tools or methods as we provide.`,
      },
      {
        text: `You may, from time to time, provide us with ideas, know-how, methodologies, comments or suggestions relating to our Services or Subscriptions ("Feedback"). If you do:`,
        children: [
          {
            text: `all Intellectual Property in the Feedback, and anything created as a result of that Feedback (including new material, enhancements, modifications or derivative works) vest in, and are owned solely by, us; and`,
          },
          { text: `we may use or disclose the Feedback for any purpose.` },
        ],
      },
      {
        text: `In these Terms, "Intellectual Property" means all statutory and other proprietary rights in respect of copyright and neighbouring rights, all rights in relation to inventions (including registered and unregistered patent rights), registered and unregistered trademarks, designs, source code, the right to have Confidential Information (including trade secrets and know-how) kept confidential, and all other rights resulting from intellectual activity in industrial scientific, literary or artistic (including musical) fields.`,
      },
    ],
  },
  {
    id: 'disputes',
    title: 'Disputes',
    clauses: [
      {
        text: `Balo Technologies may, but is not obliged to, facilitate resolution of disputes between Users and Service Providers. In all cases, Balo Technologies acts solely as the Facilitator in an administrative capacity and shall have no liability for the outcome.`,
      },
      {
        text: `If a dispute arises between you and a User in relation to the quality of a SP Service you have provided to them as notified by Balo Technologies (and which Balo Technologies deems is not frivolous or vexatious) then you agree to comply with and cooperate with us and the User to follow the below process:`,
        children: [
          {
            text: `Balo Technologies may appoint, in its sole discretion, a person who has appropriate expertise in the field to which the Service relates to ("Expert"), and who warrant that they have no relationship (personal or professional) with the Service Provider;`,
          },
          {
            text: `If either the Service Provider or the User object to the chosen Expert, they may veto the selection of the Expert on one occasion each, after which the selected Expert will be appointed to resolve the dispute.`,
          },
          { text: `The chosen Expert will then review the Service; and` },
          {
            text: `If the Expert determines that the Service provided which is in dispute, was:`,
            children: [
              {
                text: `insufficient, unreasonably departed from the agreed brief, or materially lacking in quality, then the Service Provider shall either:`,
                children: [
                  {
                    text: `re-supply to the User the Service which you provided that is in dispute; or`,
                  },
                  {
                    text: `pay to you an amount equal to the cost to the relevant User to obtain the same Service from another Service Provider via Balo Technologies`,
                  },
                ],
                after: `(at the User's election); and pay the costs of the Expert; or`,
              },
              {
                text: `sufficient and of good quality, then the User will be required to make payment of the fees for the Service provided which is in dispute, together with the costs of the Expert's determination within 5 business days of the Expert making their determination.`,
              },
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'miscellaneous',
    title: 'Miscellaneous Provisions',
    clauses: [
      {
        text: `We may from time to time change, modify, add or remove portions of these Terms. Amendments will be effective immediately upon notification on the Site. It is your responsibility to check these Terms periodically for changes. Your continued use of the Site following the posting of changes will mean that you accept and agree to the changes.`,
      },
      {
        text: `If any of these Terms are at any time held by any jurisdiction to be void, invalid or unenforceable, then it shall be treated as changed or reduced, only to the extent minimally necessary to bring it within the laws of that jurisdiction and to prevent it from being void and it shall be binding in that changed or reduced form. Subject to that, each provision or part thereof shall be interpreted as severable and shall not in any way affect any other of these terms.`,
      },
      {
        text: `No waiver by us, in exercising any right, power or provision in this document shall operate as a waiver of any other right or of that same right at a future time, nor shall any delay in exercise of any power or right be interpreted as a waiver.`,
      },
      {
        text: `We are not liable for any breach of our obligations resulting from causes beyond our reasonable control including internet outages, pandemic, epidemic, pestilence, strikes or civil unrest, and restrictions imposed by law or regulation anywhere in Australia, or the world.`,
      },
      {
        text: `These Terms record the entire agreement between the parties as to its subject matter. It supersedes any prior understandings or agreements between the parties in connection with it.`,
      },
      {
        text: `These Terms and any transactions governed by it will be governed by and construed in accordance with the law of Victoria, Australia. You submit to the exclusive jurisdiction of courts in Victoria, Australia.`,
      },
    ],
  },
];

const ROMAN_NUMERALS = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x'] as const;

/**
 * The visible number of a clause from its 1-based position path
 * (`[section, clause, subclause, item, subitem]`): `3`, `3.7`, `3.7.1`, `(a)`, `ii.`.
 */
export function clauseLabel(path: readonly number[]): string {
  const [last] = path.slice(-1);
  if (last === undefined) {
    throw new RangeError('A clause path needs at least one position');
  }
  switch (path.length) {
    case 1:
    case 2:
    case 3:
      return path.join('.');
    case 4: {
      if (last < 1 || last > 26) {
        throw new RangeError(`No letter for position ${last}`);
      }
      return `(${String.fromCodePoint(96 + last)})`;
    }
    case 5: {
      const numeral = ROMAN_NUMERALS[last - 1];
      if (numeral === undefined) {
        throw new RangeError(`No roman numeral for position ${last}`);
      }
      return `${numeral}.`;
    }
    default:
      throw new RangeError(`Unsupported clause depth ${path.length}`);
  }
}

function indexNodes(
  nodes: readonly TermsNode[],
  parentPath: readonly number[],
  index: Map<string, string>
): void {
  nodes.forEach((node, position) => {
    const path = [...parentPath, position + 1];
    if (node.id !== undefined) {
      index.set(node.id, clauseLabel(path));
    }
    if (node.children) {
      indexNodes(node.children, path, index);
    }
  });
}

/** Maps every section id and clause id to its visible number. */
export function buildClauseIndex(sections: readonly TermsSection[]): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  sections.forEach((section, position) => {
    const path = [position + 1];
    index.set(section.id, clauseLabel(path));
    indexNodes(section.clauses, path, index);
  });
  return index;
}

/** Matches a `{{clause:<id>}}` token in clause text. */
export const CLAUSE_TOKEN = /\{\{clause:([a-z0-9.-]+)\}\}/g;

/** Replaces each `{{clause:<id>}}` token with the number of that clause. Throws on an unknown id. */
export function resolveClauseRefs(text: string, index: ReadonlyMap<string, string>): string {
  return text.replaceAll(CLAUSE_TOKEN, (_token, id: string) => {
    const label = index.get(id);
    if (label === undefined) {
      throw new Error(`Unknown clause reference: ${id}`);
    }
    return label;
  });
}
