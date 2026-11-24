/**
 * The Balo Projects Master Services Agreement (BAL-662), ported word for word from the published
 * Google Doc "(Published) Projects MSA". It is the agreement between the client and the expert;
 * Balo Technologies is the Facilitator and not a party (clause 2.3).
 *
 * ⚠ Wording is the document's own, inconsistencies included: clause 7.3 repeats its number in
 * its text, 12.3 and 15.8.2 are sentence tails numbered as clauses, and cross-references keep the
 * older lettered style ("clause 7(c)"). Curly quotes are part of the text. Do not tidy them.
 *
 * Changing any word means a new `PROJECT_TERMS_VERSION`; see
 * `docs/ops/changing-the-project-agreement.md`. `project-terms-guard.test.ts` fails otherwise.
 *
 * `**bold**` and `*italic*` markers are the document's own formatting, read by `splitEmphasis`.
 */
import type { TermsSection } from './terms';

export const PROJECT_TERMS_TITLE = 'Balo Projects - Master Services Agreement';

/** ISO date of the published version. It names the PDF: `balo-projects-msa-{version}.pdf`. */
export const PROJECT_TERMS_VERSION = '2025-07-23';

/** The document's own "Last Updated" line, italic. */
export const PROJECT_TERMS_LAST_UPDATED_LINE = '*Last Updated: 23rd July 2025*';

export const PROJECT_TERMS: readonly TermsSection[] = [
  {
    id: 'definitions-and-interpretation',
    title: 'Definitions and Interpretation',
    intro: [
      'In this Agreement, unless the context requires otherwise:',
      '“**Balo Technologies**” means Balo Technologies Pty Ltd, the owner and operator of the platform located at www.balo.expert and all associated web sites, sub-domains, platforms, forums or marketplaces and mobile applications (“**Site**”).',
      '“**Confidential Information**” means any information disclosed by a Party to the other Party, either directly or indirectly, in writing, orally or by inspection of tangible objects, which is designated as “**Confidential**,” “**Proprietary**” or some similar designation, or that should reasonably be understood to be confidential given the nature of the information and the circumstances of disclosure. Confidential Information shall not include any information which: (i) was publicly known prior to the time of disclosure; (ii) becomes publicly known after disclosure through no action or inaction of the receiving Party; (iii) is already in the possession of the receiving Party at the time of disclosure; (iv) is obtained by the receiving Party from a third party without a breach of such third party’s obligations of confidentiality; or (v) is independently developed by the receiving Party without use of or reference to the disclosing Party’s Confidential Information.',
      '“**Facilitator**” refers to Balo Technologies in its capacity as a provider of software tools, communications infrastructure and payment facilitation, and not as a party to this Agreement between Service Providers and Users.',
      '“**Intellectual Property Rights**” means all statutory and other proprietary rights in respect of copyright and neighbouring rights, all rights in relation to inventions (including registered and unregistered patent rights), registered and unregistered trademarks, designs, source code, the right to have Confidential Information (including trade secrets and know-how) kept confidential, and all other rights resulting from intellectual activity in industrial, scientific, literary or artistic fields.',
      '“**Service Provider**” means the person or entity who offers the provision of demonstrations, advice or other services to Users via the Site, as identified in a Listing or a Statement of Work.',
      '“**Services**” means the services to be provided by the Service Provider to the User as described in a Statement of Work.',
      '“**Statement of Work**” or “**SOW**” means a written description of the Services to be provided by the Service Provider to the User, including deliverables, timelines, fees and payment terms, which shall be incorporated into and form part of this Agreement.',
      '“**User**” means the person or entity who engages the Service Provider to provide Services via the Site.',
    ],
    clauses: [
      {
        text: 'In this Agreement, unless the context otherwise requires:',
        children: [
          {
            text: 'headings are for convenience only and do not affect interpretation;',
          },
          {
            text: 'the singular includes the plural and vice versa;',
          },
          {
            text: 'a reference to a document or agreement (including this Agreement) includes that document or agreement as novated, altered, supplemented or replaced from time to time;',
          },
          {
            text: 'a reference to a Party includes that Party’s executors, administrators, successors, permitted assigns and permitted substitutes;',
          },
          {
            text: 'a reference to a person includes a natural person, body corporate, partnership, joint venture, association or other entity; and',
          },
          {
            text: 'the words “include”, “including”, “for example” or “such as” are not used as, nor are they to be interpreted as, words of limitation, and, when introducing an example, do not limit the meaning of the words to which the example relates.',
          },
        ],
      },
    ],
  },
  {
    id: 'scope-of-agreement',
    title: 'Scope of Agreement',
    clauses: [
      {
        text: 'This Agreement governs the provision of Services by the Service Provider to the User, as specified in each Statement of Work agreed between the Parties.',
      },
      {
        text: 'Each Statement of Work forms part of this Agreement and is subject to the terms and conditions set forth herein. In the event of any conflict between the terms of this Agreement and any Statement of Work, the terms of this Agreement shall prevail unless the Statement of Work expressly states that it is intended to override specific provisions of this Agreement.',
      },
      {
        text: 'The Parties acknowledge and agree that:',
        children: [
          {
            text: 'Balo Technologies acts solely as a Facilitator of the relationship between the Parties and is not a party to this Agreement;',
          },
          {
            text: 'this Agreement creates a direct contractual relationship between the Service Provider and the User;',
          },
          {
            text: 'Balo Technologies bears no responsibility or liability for the performance of either Party’s obligations under this Agreement; and',
          },
          {
            text: 'any dispute arising under this Agreement shall be resolved directly between the Parties in accordance with the dispute resolution provisions set forth herein.',
          },
        ],
      },
    ],
  },
  {
    id: 'services-and-obligations-of-the-service-provider',
    title: 'Services and Obligations of the Service Provider',
    clauses: [
      {
        text: 'The Service Provider shall:',
        children: [
          {
            text: 'provide the Services with reasonable skill, care and diligence, in accordance with industry standards and best practices applicable to the nature of the Services;',
          },
          {
            text: 'ensure that all Services are provided by appropriately qualified and experienced personnel;',
          },
          {
            text: 'comply with all reasonable requests and instructions from the User that are necessary for the proper provision of the Services;',
          },
          {
            text: 'allocate sufficient time, attention, and resources to provide the Services in a timely manner and in accordance with any agreed timeframes;',
          },
          {
            text: 'promptly notify the User of any delay or issues that may affect the delivery of the Services;',
          },
          {
            text: 'comply with all applicable laws, regulations, codes of practice and industry standards in the provision of the Services;',
          },
          {
            text: 'maintain all necessary licences, certifications, permits and authorisations required to provide the Services; and',
          },
          {
            text: 'keep detailed records of all Services provided and make such records available to the User upon reasonable request.',
          },
        ],
      },
      {
        text: 'The Service Provider acknowledges and agrees that:',
        children: [
          {
            text: 'it is an independent contractor and not an employee, agent, or partner of the User or Balo Technologies;',
          },
          {
            text: 'it shall be solely responsible for determining the manner and means of providing the Services;',
          },
          {
            text: 'it shall be solely responsible for payment of all taxes, insurance, and other expenses related to its business; and',
          },
          {
            text: 'nothing in this Agreement creates a partnership, joint venture, agency, or employment relationship between the Parties.',
          },
        ],
      },
      {
        text: 'The Service Provider represents and warrants that:',
        children: [
          {
            text: 'all information provided to the User regarding the Service Provider’s qualifications, experience, and capabilities is true, accurate and not misleading;',
          },
          {
            text: 'the Service Provider possesses the necessary skills, qualifications, and experience to provide the Services;',
          },
          {
            text: 'the provision of the Services will not infringe the Intellectual Property Rights or other rights of any third party; and',
          },
          {
            text: 'the Service Provider is not subject to any restriction, limitation, or condition that might affect its ability to provide the Services or fulfil its obligations under this Agreement.',
          },
        ],
      },
    ],
  },
  {
    id: 'obligations-of-the-user',
    title: 'Obligations of the User',
    clauses: [
      {
        text: 'The User shall:',
        children: [
          {
            text: 'provide the Service Provider with all information, materials, access, and cooperation reasonably required for the Service Provider to provide the Services;',
          },
          {
            text: 'ensure that all information and materials provided to the Service Provider are accurate, complete, and not misleading;',
          },
          {
            text: 'provide timely feedback, reviews, and approvals as reasonably requested by the Service Provider;',
          },
          {
            text: 'pay all fees and charges due to the Service Provider in accordance with the payment terms set forth in the applicable Statement of Work and this Agreement;',
          },
          {
            text: 'comply with all applicable laws, regulations, and codes of practice in connection with this Agreement; and',
          },
          {
            text: 'use the Services and any deliverables provided by the Service Provider only for their intended purpose and in accordance with any instructions or guidelines provided by the Service Provider.',
          },
        ],
      },
      {
        text: 'The User acknowledges and agrees that:',
        children: [
          {
            text: 'the performance of the Services may depend on the User’s timely provision of information, materials, access, and cooperation;',
          },
          {
            text: 'any delay or failure by the User to fulfil its obligations under this Agreement may result in corresponding delays or failures in the delivery of the Services, for which the Service Provider shall not be liable; and',
          },
          {
            text: 'any additional work required as a result of incomplete, inaccurate, or misleading information provided by the User may result in additional charges.',
          },
        ],
      },
    ],
  },
  {
    id: 'statements-of-work',
    title: 'Statements of Work',
    clauses: [
      {
        text: 'Prior to the commencement of any Services, the Parties shall agree upon and execute a Statement of Work that includes:',
        children: [
          {
            text: 'a detailed description of the Services to be provided;',
          },
          {
            text: 'any deliverables to be produced by the Service Provider;',
          },
          {
            text: 'the timeframe for delivery and any applicable milestones;',
          },
          {
            text: 'the fees payable for the Services and the payment terms;',
          },
          {
            text: 'any specific requirements, assumptions, or dependencies relevant to the provision of the Services;',
          },
          {
            text: 'any constraints or limitations applicable to the Services; and',
          },
          {
            text: 'any other terms specific to the particular engagement.',
          },
        ],
      },
      {
        text: 'A Statement of Work may be accepted by the User orally or in writing, but in any event the User will be deemed to have accepted a Statement of Work if it accepts any Services described in the relevant Statement of Work from the Service Provider.',
      },
      {
        text: 'Upon acceptance or deemed acceptance of the Statement of Work by the User, a binding contract will be formed between the Service Provider and the User for the provision of the Services on the terms set out in the Statement of Work and this Agreement.',
      },
      {
        text: 'A Statement of Work may be amended only by written agreement of both Parties.',
      },
      {
        text: 'Unless otherwise specified in a Statement of Work, all time-based fees shall be calculated on the basis of credits as defined and valued in accordance with the Service Provider’s rates as published on the Site at the time the Statement of Work is executed.',
      },
      {
        text: 'The Service Provider shall not commence work on any Services until a Statement of Work has been executed by both Parties, unless otherwise agreed in writing.',
      },
      {
        text: 'If there is any inconsistency between this Agreement and a Statement of Work, the terms of the Statement of Work shall prevail to the extent of the inconsistency.',
      },
    ],
  },
  {
    id: 'fees-and-payment',
    title: 'Fees and Payment',
    clauses: [
      {
        text: 'In consideration for the provision of the Services, the User shall pay to the Service Provider the fees specified in the applicable Statement of Work.',
      },
      {
        text: 'Unless otherwise specified in a Statement of Work:',
        children: [
          {
            text: 'all fees shall be paid through the payment mechanism provided by Balo Technologies on the Site and/or using the credit system described in the Site’s Terms and Conditions;',
          },
          {
            text: 'the User shall be paid through the payment mechanism provided by Balo Technologies on the Site, and/or purchase sufficient credits to cover the estimated cost of the Services prior to the commencement of the Services;',
          },
          {
            text: 'for time-based Services, shall be paid through the payment mechanism provided by Balo Technologies on the Site, and/or credits shall be deducted from the User’s account based on the actual time spent by the Service Provider in providing the Services, at the rate specified in the Statement of Work; and',
          },
          {
            text: 'for fixed-price Services, shall be paid through the payment mechanism provided by Balo Technologies on the Site, and/or credits shall be deducted from the User’s account upon acceptance of the Statement of Work or in installments as set out in the Statement of Work.',
          },
        ],
      },
      {
        text: 'All amounts stated in this Agreement or any Statement of Work are inclusive of applicable taxes (including but not limited to value added tax, goods and services tax, or sales tax), which shall be payable by the User in addition to the fees.',
      },
      {
        text: 'If the User reasonably disputes any portion of an amount charged, the User shall notify the Service Provider and Balo Technologies in writing within seven (7) days of the charge being processed, providing details of the dispute. The Parties shall work in good faith to resolve the dispute in accordance with the dispute resolution provisions set forth in this Agreement.',
      },
      {
        text: 'The Service Provider acknowledges that Balo Technologies acts as a billing agent for the Service Provider in collecting fees from the User. The User acknowledges that payment to Balo Technologies constitutes payment to the Service Provider for the purposes of this Agreement.',
      },
      {
        text: 'The Service Provider shall be solely responsible for all costs and expenses incurred in providing the Services, unless otherwise specified in the Statement of Work.',
      },
      {
        text: 'In addition to the fees, the User will reimburse the Service Provider the actual costs of any pre-approved disbursements reasonably incurred by the Service Provider in carrying out the Services. Any expenses in excess of $500 AUD are subject to prior written approval by the User.',
      },
      {
        text: 'If the User fails to pay any amount due under this Agreement by the due date, without prejudice to any other rights the Service Provider may have under this Agreement or at law, the Service Provider shall be entitled to:',
        children: [
          {
            text: 'suspend the provision of Services until payment is received in full; and',
          },
          {
            text: 'charge interest on the overdue amount at the rate of 1% per month, calculated from the due date until the date of actual payment.',
          },
        ],
      },
    ],
  },
  {
    id: 'intellectual-property-rights',
    title: 'Intellectual Property Rights',
    clauses: [
      {
        text: 'Subject to clause 7(c), all Intellectual Property Rights in any materials, information, data, or content provided by a Party to the other Party for the purposes of this Agreement shall remain the property of the providing Party.',
      },
      {
        text: 'All Intellectual Property Rights in the deliverables created by the Service Provider in the course of providing the Services (“Deliverables”) shall, upon payment in full of all fees due under the applicable Statement of Work, vest in the User, unless otherwise specified in the Statement of Work.',
      },
      {
        text: '7.3 Notwithstanding clause 7(b), the Service Provider shall retain ownership of:',
        children: [
          {
            text: 'any pre-existing materials, methodologies, tools, techniques, or know-how used to create the Deliverables (“Pre-existing Materials”);',
          },
          {
            text: 'any general skills, knowledge, experience, or ideas that the Service Provider possessed prior to providing the Services or acquired in the course of providing the Services; and',
          },
          {
            text: 'any generic, non-client-specific components, algorithms, methods, or processes developed by the Service Provider that have general application and are incorporated into the Deliverables.',
          },
        ],
      },
      {
        text: 'The Service Provider hereby grants to the User a non-exclusive, perpetual, irrevocable, worldwide, royalty-free licence to use, reproduce, modify, and distribute the Pre-existing Materials, but only as part of, and for the purposes of using, the Deliverables.',
      },
      {
        text: 'The User hereby grants to the Service Provider a non-exclusive, non-transferable, revocable licence to use the User’s materials, information, data, and content solely for the purpose of providing the Services under this Agreement.',
      },
      {
        text: 'The Service Provider warrants that:',
        children: [
          {
            text: 'the Deliverables will be original works of the Service Provider or its personnel, or works to which the Service Provider has all necessary rights;',
          },
          {
            text: 'the Deliverables, and the User’s use of the Deliverables in accordance with this Agreement, will not infringe the Intellectual Property Rights or other rights of any third party; and',
          },
          {
            text: 'the Service Provider has the right to assign or license any Intellectual Property Rights as required under this Agreement.',
          },
        ],
      },
      {
        text: 'Each Party shall promptly notify the other Party if it becomes aware of any claim that the Deliverables infringe the Intellectual Property Rights or other rights of any third party.',
      },
    ],
  },
  {
    id: 'confidentiality',
    title: 'Confidentiality',
    clauses: [
      {
        text: 'Each Party agrees to keep confidential all Confidential Information of the other Party and shall not disclose such Confidential Information to any third party without the prior written consent of the disclosing Party.',
      },
      {
        text: 'Each Party shall use the Confidential Information of the other Party only for the purposes of fulfilling its obligations or exercising its rights under this Agreement.',
      },
      {
        text: 'Each Party shall protect the Confidential Information of the other Party using the same degree of care that it uses to protect its own confidential information of a similar nature, but in no event less than reasonable care.',
      },
      {
        text: 'Each Party may disclose Confidential Information to its employees, professional advisers, agents, and subcontractors on a need-to-know basis, provided that:',
        children: [
          {
            text: 'such employees, professional advisers, agents, and subcontractors are bound by confidentiality obligations no less restrictive than those set forth in this Agreement; and',
          },
          {
            text: 'the disclosing Party shall be responsible for any breach of this clause by its employees, professional advisers, agents, and subcontractors.',
          },
        ],
      },
      {
        text: 'A Party may disclose Confidential Information to the extent required by law, regulation, court order, or the rules of any applicable stock exchange, provided that, to the extent legally permissible, the disclosing Party provides the other Party with prompt written notice of such requirement and reasonably cooperates with the other Party’s efforts to limit such disclosure or obtain a protective order.',
      },
      {
        text: 'Upon termination or expiration of this Agreement, or upon the written request of the disclosing Party, the receiving Party shall promptly return or destroy all Confidential Information of the disclosing Party in its possession or control, including all copies, extracts, and derivatives thereof, except to the extent that retention is required by law or regulatory requirements.',
      },
      {
        text: 'The obligations of confidentiality set forth in this clause shall survive the termination or expiration of this Agreement for a period of three (3) years, except that with respect to Confidential Information that constitutes a trade secret, such obligations shall continue for as long as such information remains a trade secret under applicable law.',
      },
    ],
  },
  {
    id: 'data-protection',
    title: 'Data Protection',
    clauses: [
      {
        text: 'Each Party shall comply with all applicable data protection and privacy laws and regulations in connection with this Agreement.',
      },
      {
        text: 'The Service Provider shall:',
        children: [
          {
            text: 'process personal data only to the extent necessary to provide the Services and in accordance with the User’s documented instructions;',
          },
          {
            text: 'implement appropriate technical and organisational measures to protect personal data against unauthorised or unlawful processing, accidental loss, destruction, or damage;',
          },
          {
            text: 'ensure that its personnel who process personal data are subject to appropriate confidentiality obligations;',
          },
          {
            text: 'not engage any third-party processor without the prior written authorisation of the User;',
          },
          {
            text: 'assist the User in responding to requests from data subjects and in ensuring compliance with the User’s data protection obligations; and',
          },
          {
            text: 'at the choice of the User, delete or return all personal data to the User after the end of the provision of Services, unless retention is required by law.',
          },
        ],
      },
      {
        text: 'The User warrants that it has all necessary rights, consents, and authorisations to collect and provide to the Service Provider any personal data that it provides in connection with this Agreement.',
      },
      {
        text: 'Each Party shall promptly notify the other Party of any actual or suspected personal data breach affecting personal data processed in connection with this Agreement.',
      },
    ],
  },
  {
    id: 'term-and-termination',
    title: 'Term and Termination',
    clauses: [
      {
        text: 'This Agreement shall commence on the date it is executed by both Parties and shall continue until terminated in accordance with this clause.',
      },
      {
        text: 'A Statement of Work shall commence on the date specified therein and shall continue until:',
        children: [
          {
            text: 'completion of the Services specified in the Statement of Work;',
          },
          {
            text: 'termination of the Statement of Work in accordance with its terms or this Agreement; or',
          },
          {
            text: 'termination of this Agreement.',
          },
        ],
      },
      {
        text: 'Either Party may terminate this Agreement or any Statement of Work immediately by written notice if:',
        children: [
          {
            text: 'the other Party commits a material breach of this Agreement or the Statement of Work and fails to remedy such breach within fourteen (14) days of receiving written notice requiring it to do so;',
          },
          {
            text: 'the other Party commits a material breach of this Agreement or the Statement of Work that is not capable of remedy;',
          },
          {
            text: 'the other Party becomes insolvent, enters into liquidation or bankruptcy, makes an arrangement with its creditors, or has a receiver, administrator or liquidator appointed; or',
          },
          {
            text: 'the other Party ceases, or threatens to cease, to carry on business.',
          },
        ],
      },
      {
        text: 'The User may terminate any Statement of Work for convenience by providing at least seven (7) days’ written notice to the Service Provider, subject to payment of:',
        children: [
          {
            text: 'all fees due for Services properly provided up to the date of termination; and',
          },
          {
            text: 'any reasonable costs directly incurred by the Service Provider as a result of such termination, provided that the Service Provider takes all reasonable steps to mitigate such costs.',
          },
        ],
      },
      {
        text: 'The Service Provider may terminate any Statement of Work for convenience by providing at least thirty (30) days’ written notice to the User, subject to:',
        children: [
          {
            text: 'completion of any critical or time-sensitive Services as reasonably determined by the User and notified to the Service Provider within seven (7) days of receiving the notice of termination; and',
          },
          {
            text: 'providing reasonable assistance to the User in transitioning the Services to another service provider.',
          },
        ],
      },
      {
        text: 'Upon termination or expiration of a Statement of Work or this Agreement:',
        children: [
          {
            text: 'the Service Provider shall promptly deliver to the User all Deliverables (whether complete or incomplete) for which the User has paid;',
          },
          {
            text: 'the User shall pay all undisputed fees due to the Service Provider for Services properly provided up to the date of termination or expiration; and',
          },
          {
            text: 'each Party shall return or destroy, at the option of the disclosing Party, all Confidential Information of the other Party in its possession or control, except to the extent that retention is required by law or regulatory requirements.',
          },
        ],
      },
      {
        text: 'The termination or expiration of this Agreement or any Statement of Work shall not affect any rights or obligations that may have accrued prior to termination or expiration, or any provisions of this Agreement that by their nature are intended to survive termination or expiration.',
      },
      {
        text: 'Despite any other provision of this Agreement and in the absence of contrary intention, the termination of a particular Statement of Work will not operate to terminate this Agreement or any other Statement of Work.',
      },
    ],
  },
  {
    id: 'warranties-and-disclaimers',
    title: 'Warranties and Disclaimers',
    clauses: [
      {
        text: 'Each Party warrants that:',
        children: [
          {
            text: 'it has full capacity and authority to enter into and perform this Agreement and any Statement of Work;',
          },
          {
            text: 'this Agreement and each Statement of Work is executed by a duly authorised representative of that Party; and',
          },
          {
            text: 'it shall comply with all applicable laws, regulations, codes of practice, and industry standards in connection with this Agreement.',
          },
        ],
      },
      {
        text: 'The Service Provider warrants that:',
        children: [
          {
            text: 'it possesses the necessary skills, qualifications, and experience to provide the Services;',
          },
          {
            text: 'the Services will be provided with reasonable skill, care, and diligence, in accordance with industry standards and best practices;',
          },
          {
            text: 'the Services will conform to the description and specifications set forth in the applicable Statement of Work; and',
          },
          {
            text: 'any deliverables provided as part of the Services will be fit for their intended purpose as specified in the applicable Statement of Work.',
          },
        ],
      },
      {
        text: 'The User acknowledges and agrees that:',
        children: [
          {
            text: 'the Service Provider does not warrant that the Services or any deliverables will meet the User’s requirements unless such requirements are expressly set forth in the applicable Statement of Work;',
          },
          {
            text: 'any advice, guidance, information, or services provided by the Service Provider are provided at the User’s own risk;',
          },
          {
            text: 'implementing or acting upon any such advice, guidance, information, or services may carry inherent risks and uncertainties;',
          },
          {
            text: 'outcomes cannot be guaranteed; and',
          },
          {
            text: 'the User should exercise its own judgment and, where appropriate, seek independent professional advice before implementing any significant changes based on advice received from the Service Provider.',
          },
        ],
      },
      {
        text: 'Except as expressly set forth in this Agreement, all warranties, conditions, and other terms implied by statute or common law are, to the fullest extent permitted by law, excluded from this Agreement.',
      },
    ],
  },
  {
    id: 'limitation-of-liability',
    title: 'Limitation of Liability',
    clauses: [
      {
        text: 'Nothing in this Agreement shall limit or exclude either Party’s liability for:',
        children: [
          {
            text: 'death or personal injury caused by its negligence;',
          },
          {
            text: 'fraud or fraudulent misrepresentation;',
          },
          {
            text: 'any breach of the obligations implied by applicable consumer protection legislation; or',
          },
          {
            text: 'any other liability that cannot be limited or excluded by applicable law.',
          },
        ],
      },
      {
        text: 'Subject to clause 12(a), neither Party shall be liable to the other Party, whether in contract, tort (including negligence), breach of statutory duty, or otherwise, for:',
        children: [
          {
            text: 'any loss of profit, revenue, business opportunity, anticipated savings, goodwill, or reputation; or',
          },
          {
            text: 'any indirect, special, or consequential loss or damage,',
          },
        ],
      },
      {
        text: 'arising under or in connection with this Agreement, whether or not such loss or damage was foreseeable or contemplated by the Parties.',
      },
      {
        text: 'Subject to clauses 12(a) and 12(b), each Party’s total aggregate liability to the other Party, whether in contract, tort (including negligence), breach of statutory duty, or otherwise, arising under or in connection with this Agreement shall be limited to the total fees paid or payable by the User to the Service Provider under the Statement of Work to which the claim relates, or, if the claim does not relate to a specific Statement of Work, to the total fees paid or payable by the User to the Service Provider under this Agreement in the twelve (12) months preceding the event giving rise to the claim.',
      },
      {
        text: 'The Parties acknowledge and agree that:',
        children: [
          {
            text: 'the limitations and exclusions of liability set forth in this clause are reasonable in the circumstances, having regard to the nature of the Services and the fees payable; and',
          },
          {
            text: 'Balo Technologies shall have no liability to either Party for any loss or damage arising under or in connection with this Agreement, whether in contract, tort (including negligence), breach of statutory duty, or otherwise.',
          },
        ],
      },
    ],
  },
  {
    id: 'indemnification',
    title: 'Indemnification',
    clauses: [
      {
        text: 'The Service Provider shall indemnify, defend, and hold harmless the User from and against any and all losses, damages, liabilities, costs, and expenses (including reasonable legal fees) incurred by the User as a result of any claim that the Deliverables infringe the Intellectual Property Rights of any third party, except to the extent that such claim arises from:',
        children: [
          {
            text: 'the User’s use of the Deliverables in a manner not authorised by this Agreement or the applicable Statement of Work;',
          },
          {
            text: 'the User’s modification of the Deliverables without the Service Provider’s consent; or',
          },
          {
            text: 'the User’s failure to implement changes recommended by the Service Provider that would have avoided the infringement.',
          },
        ],
      },
      {
        text: 'The User shall indemnify, defend, and hold harmless the Service Provider from and against any and all losses, damages, liabilities, costs, and expenses (including reasonable legal fees) incurred by the Service Provider as a result of any claim arising from:',
        children: [
          {
            text: 'the User’s use of the Services or Deliverables in a manner not authorised by this Agreement or the applicable Statement of Work;',
          },
          {
            text: 'any materials, information, data, or content provided by the User to the Service Provider for use in providing the Services; or',
          },
          {
            text: 'the User’s breach of any warranty, representation, or obligation under this Agreement.',
          },
        ],
      },
      {
        text: 'A Party seeking indemnification under this clause (the “Indemnified Party”) shall:',
        children: [
          {
            text: 'promptly notify the other Party (the “Indemnifying Party”) in writing of any claim for which it seeks indemnification;',
          },
          {
            text: 'give the Indemnifying Party sole control over the defence and settlement of such claim; and',
          },
          {
            text: 'provide the Indemnifying Party, at the Indemnifying Party’s expense, with all assistance reasonably requested in connection with the defence and settlement of such claim.',
          },
        ],
      },
      {
        text: 'The Indemnifying Party shall not settle any claim in a manner that adversely affects the Indemnified Party’s rights without the Indemnified Party’s prior written consent, such consent not to be unreasonably withheld or delayed.',
      },
    ],
  },
  {
    id: 'insurance',
    title: 'Insurance',
    clauses: [
      {
        text: 'The Service Provider shall maintain, at its own expense, appropriate insurance coverage for the provision of the Services, including but not limited to:',
        children: [
          {
            text: 'professional indemnity insurance with a minimum coverage of AUD$1,000,000 per claim;',
          },
          {
            text: 'public liability insurance with a minimum coverage of AUD$1,000,000 per occurrence; and',
          },
          {
            text: 'any other insurance required by applicable law.',
          },
        ],
      },
      {
        text: 'The Service Provider shall, upon request, provide the User with certificates of insurance evidencing the coverage required under this clause.',
      },
      {
        text: 'The Service Provider shall ensure that all insurance policies required under this clause are maintained for the duration of this Agreement and for a period of at least one (1) year following the termination or expiration of this Agreement.',
      },
    ],
  },
  {
    id: 'dispute-resolution',
    title: 'Dispute Resolution',
    clauses: [
      {
        text: 'If a dispute arises out of or in connection with this Agreement or any Statement of Work, the Parties shall first attempt to resolve the dispute through good faith negotiations.',
      },
      {
        text: 'If the Parties are unable to resolve the dispute through negotiations within fourteen (14) days of one Party notifying the other of the dispute, either Party may refer the dispute to mediation in accordance with the mediation rules of a reputable mediation organisation.',
      },
      {
        text: 'If the Parties are unable to resolve the dispute through mediation within thirty (30) days of the appointment of a mediator, either Party may commence legal proceedings.',
      },
      {
        text: 'Nothing in this clause shall prevent either Party from seeking urgent injunctive or declaratory relief where necessary to protect its rights or property.',
      },
      {
        text: 'If a dispute arises between the Parties in relation to the quality of the Services provided by the Service Provider, and the dispute cannot be resolved through negotiations, the Parties agree to engage an independent expert with appropriate expertise in the field to which the Services relate (the “Expert”) to review the Services and make a determination as to whether the Services were provided in accordance with this Agreement and the applicable Statement of Work.',
      },
      {
        text: 'The Parties shall jointly appoint the Expert, and if they cannot agree on the appointment, they shall request that Balo Technologies appoint an appropriate Expert. The Expert’s determination shall be final and binding on the Parties, except in the case of manifest error.',
      },
      {
        text: 'The costs of the Expert shall be borne:',
        children: [
          {
            text: 'by the Service Provider, if the Expert determines that the Services were not provided in accordance with this Agreement or the applicable Statement of Work; or',
          },
          {
            text: 'by the User, if the Expert determines that the Services were provided in accordance with this Agreement and the applicable Statement of Work.',
          },
        ],
      },
      {
        text: 'If the Expert determines that the Services provided which are in dispute were:',
        children: [
          {
            text: 'insufficient, unreasonably departed from the agreed Statement of Work, or materially lacking in quality, then the Service Provider shall either:',
            children: [
              {
                text: 're-supply to the User the Services which are in dispute; or',
              },
              {
                text: 'refund to the User the amount paid for the relevant Services, or the value of the credits used to receive the relevant Services,',
              },
            ],
          },
          {
            text: 'at the User’s election; or',
          },
          {
            text: 'sufficient and of good quality, then the User will not be refunded any amount paid for the Services which are in dispute.',
          },
        ],
      },
      {
        text: 'The Parties acknowledge that Balo Technologies may, but is not obliged to, facilitate resolution of disputes between the Parties. In all cases, Balo Technologies acts solely as the Facilitator in an administrative capacity and shall have no liability for the outcome of any dispute resolution process.',
      },
    ],
  },
  {
    id: 'force-majeure',
    title: 'Force Majeure',
    clauses: [
      {
        text: 'Neither Party shall be in breach of this Agreement or any Statement of Work, nor liable for any delay in performing or failure to perform any of its obligations under this Agreement or any Statement of Work, if such delay or failure results from a Force Majeure Event.',
      },
      {
        text: 'A “Force Majeure Event” means any event or circumstance beyond the reasonable control of the affected Party, including but not limited to:',
        children: [
          {
            text: 'acts of God, flood, drought, earthquake, or other natural disaster;',
          },
          {
            text: 'epidemic or pandemic;',
          },
          {
            text: 'terrorist attack, civil war, civil commotion, riots, war, threat of or preparation for war, armed conflict, or imposition of sanctions;',
          },
          {
            text: 'nuclear, chemical, or biological contamination;',
          },
          {
            text: 'any law or action taken by a government or public authority, including imposing an export or import restriction, quota, or prohibition;',
          },
          {
            text: 'collapse of buildings, fire, explosion, or accident; or',
          },
          {
            text: 'interruption or failure of utility service, including electric power, telecommunications, or internet.',
          },
        ],
      },
      {
        text: 'The affected Party shall:',
        children: [
          {
            text: 'as soon as reasonably practicable, notify the other Party in writing of the nature and extent of the Force Majeure Event; and',
          },
          {
            text: 'use all reasonable endeavours to mitigate the effect of the Force Majeure Event on the performance of its obligations under this Agreement.',
          },
        ],
      },
      {
        text: 'If a Force Majeure Event prevents, hinders, or delays the affected Party’s performance of its obligations for a continuous period of more than thirty (30) days, the Party not affected by the Force Majeure Event may terminate this Agreement or any affected Statement of Work by giving written notice to the affected Party.',
      },
    ],
  },
  {
    id: 'general',
    title: 'General',
    clauses: [
      {
        text: '**Entire Agreement.** This Agreement, together with any Statements of Work, constitutes the entire agreement between the Parties with respect to its subject matter and supersedes all prior agreements, understandings, and negotiations, whether written or oral, between the Parties with respect to such subject matter.',
      },
      {
        text: '**Amendment.** This Agreement may be amended only by a written instrument executed by both Parties. A Statement of Work may be amended only by a written instrument executed by both Parties or as otherwise provided in the Statement of Work.',
      },
      {
        text: '**Waiver.** No failure or delay by a Party to exercise any right or remedy under this Agreement shall constitute a waiver of that or any other right or remedy, nor shall it prevent or restrict the further exercise of that or any other right or remedy. No single or partial exercise of such right or remedy shall prevent or restrict the further exercise of that or any other right or remedy.',
      },
      {
        text: '**Severability.** If any provision of this Agreement is held to be invalid, illegal, or unenforceable, it shall be deemed modified to the minimum extent necessary to make it valid, legal, and enforceable. If such modification is not possible, the relevant provision shall be deemed deleted. Any modification to or deletion of a provision shall not affect the validity and enforceability of the rest of this Agreement.',
      },
      {
        text: '**Assignment and Subcontracting.**',
        children: [
          {
            text: 'Neither Party may assign, transfer, or subcontract any of its rights or obligations under this Agreement without the prior written consent of the other Party, such consent not to be unreasonably withheld or delayed.',
          },
          {
            text: 'Notwithstanding clause 17.5(a), either Party may assign or transfer all of its rights and obligations under this Agreement to any person to which it transfers all or substantially all of its business or assets, provided that the assignee or transferee agrees in writing to be bound by the terms of this Agreement.',
          },
          {
            text: 'If the Service Provider subcontracts any of its obligations under this Agreement, it shall remain fully responsible for the performance of those obligations and shall ensure that the subcontractor complies with the terms of this Agreement.',
          },
        ],
      },
      {
        text: '**No Partnership or Agency.** Nothing in this Agreement is intended to, or shall be deemed to, establish any partnership or joint venture between the Parties, constitute either Party the agent of the other, or authorise either Party to make or enter into any commitments for or on behalf of the other.',
      },
      {
        text: '**Third-Party Rights.** No person other than a Party to this Agreement shall have any rights to enforce any term of this Agreement.',
      },
      {
        text: '**Notices.**',
        children: [
          {
            text: 'Any notice given to a Party under or in connection with this Agreement shall be in writing and shall be delivered:',
            children: [
              {
                text: 'by hand or by pre-paid first-class post or other next working day delivery service at its registered office (if a company) or its principal place of business (in any other case); or',
              },
              {
                text: 'by email to the address specified in the Statement of Work or such other email address as may be notified by one Party to the other from time to time.',
              },
            ],
          },
          {
            text: 'Any notice shall be deemed to have been received:',
            children: [
              {
                text: 'if delivered by hand, on signature of a delivery receipt or at the time the notice is left at the proper address;',
              },
              {
                text: 'if sent by pre-paid first-class post or other next working day delivery service, at 9.00 am on the second business day after posting; or',
              },
              {
                text: 'if sent by email, at the time of transmission, or, if this time falls outside business hours in the place of receipt, when business hours resume.',
              },
            ],
          },
          {
            text: 'This clause does not apply to the service of any proceedings or other documents in any legal action or, where applicable, any arbitration or other method of dispute resolution.',
          },
          {
            text: 'For the purposes of this clause, “business hours” means 9.00 am to 5.00 pm on a day other than a Saturday, Sunday, or public holiday in the place of receipt.',
          },
        ],
      },
      {
        text: '**Counterparts.** This Agreement may be executed in any number of counterparts, each of which when executed shall constitute a duplicate original, but all the counterparts shall together constitute the one agreement.',
      },
      {
        text: '**Governing Law and Jurisdiction.** This Agreement and any dispute or claim arising out of or in connection with it or its subject matter or formation (including non-contractual disputes or claims) shall be governed by and construed in accordance with the law of Victoria, Australia. Each Party irrevocably agrees that the courts of Victoria, Australia shall have exclusive jurisdiction to settle any dispute or claim arising out of or in connection with this Agreement or its subject matter or formation (including non-contractual disputes or claims).',
      },
    ],
  },
  {
    id: 'change-request-process',
    title: 'Change Request Process',
    clauses: [
      {
        text: 'It may become necessary to amend a Statement of Work from time to time for reasons including but not limited to:',
        children: [
          {
            text: 'discretionary changes (as agreed by both Parties) in the scope of work, such as addition or removal of estimated project activities;',
          },
          {
            text: 'requested changes to the work hours or deliverables;',
          },
          {
            text: 'non-availability of products, resources, or services which are beyond the Service Provider’s control;',
          },
          {
            text: 'impediments not previously identified; or',
          },
          {
            text: 'lack of access to personnel or facilities necessary to complete the Services.',
          },
        ],
      },
      {
        text: 'A Change Request shall be the vehicle for formally communicating and agreeing to any change to a Statement of Work.',
      },
      {
        text: 'The Party requesting the change shall provide a written Change Request to the other Party, setting out:',
        children: [
          {
            text: 'a description of the proposed change;',
          },
          {
            text: 'the reason for the proposed change;',
          },
          {
            text: 'the impact of the proposed change on the Services, fees, timeframes, and any other relevant aspects of the Statement of Work; and',
          },
          {
            text: 'any other information relevant to the proposed change.',
          },
        ],
      },
      {
        text: 'The other Party shall consider the Change Request in good faith and respond within seven (7) days of receipt, either accepting, rejecting, or proposing amendments to the Change Request.',
      },
      {
        text: 'Upon acceptance and execution of the Change Request by both Parties, the Statement of Work shall be deemed to be modified accordingly, and the changes will be incorporated into the Statement of Work.',
      },
      {
        text: 'No change to a Statement of Work shall be effective unless and until a Change Request has been accepted and executed by both Parties.',
      },
    ],
  },
  {
    id: 'execution',
    title: 'Execution',
    clauses: [
      {
        text: 'By clicking “I Accept” or otherwise indicating acceptance through the Site, or by commencing the provision or receipt of Services, each Party agrees to be bound by the terms of this Agreement.',
      },
      {
        text: 'Each Party represents and warrants that the person entering into this Agreement on its behalf has the legal authority to do so.',
      },
      {
        text: 'This Agreement may be executed in any number of counterparts, each of which when executed shall constitute a duplicate original, but all the counterparts shall together constitute the one agreement.',
      },
      {
        text: 'The Parties do not need to sign this Agreement to accept the terms and conditions, and instructing the Service Provider to commence work or the User requesting Services will be deemed acceptance of these terms.',
      },
    ],
  },
];
