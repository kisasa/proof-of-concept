import { TerraformIterator, Token } from "cdktn";
import { Construct } from "constructs";
import { AcmCertificate } from "@cdktn/provider-aws/lib/acm-certificate";
import { AcmCertificateValidation } from "@cdktn/provider-aws/lib/acm-certificate-validation";
import { Route53Record } from "@cdktn/provider-aws/lib/route53-record";


export interface DomainCertificateConfig {
  readonly domainName: string;
  readonly hostedZoneId: string;
  readonly globalTags: Record<string, string>;
}

/**
 * A DNS-validated ACM certificate plus the Route53 records that validate it.
 *
 * `validatedCertificateArn` is the arn of the *validation* resource rather than
 * the certificate, which is what makes a listener that consumes it wait for
 * validation to finish. Referencing the certificate directly would let Terraform
 * attach a still-pending certificate and fail the apply.
 */
export class DomainCertificate extends Construct {
  public readonly validatedCertificateArn: string;

  constructor(scope: Construct, id: string, config: DomainCertificateConfig) {
    super(scope, id);

    const certificate = new AcmCertificate(this, "certificate", {
      domainName: config.domainName,
      validationMethod: "DNS",
      tags: config.globalTags,

      // A certificate in use by a listener cannot be destroyed, so a change that
      // replaces it has to build the replacement first.
      lifecycle: { createBeforeDestroy: true },
    });

    // domain_validation_options is a set, which cannot be indexed directly in
    // Terraform. Iterating it into a for_each is the supported way to turn it
    // into records — one per domain, which today means exactly one.
    const validationOptions = TerraformIterator.fromComplexList(certificate.domainValidationOptions, "domain_name");

    const validationRecord = new Route53Record(this, "validation-record", {
      forEach: validationOptions,
      zoneId: config.hostedZoneId,
      name: validationOptions.getString("resource_record_name"),
      type: validationOptions.getString("resource_record_type"),
      records: [validationOptions.getString("resource_record_value")],
      ttl: 60,

      // Re-running after a partially failed apply otherwise trips over the
      // validation record it created last time.
      allowOverwrite: true,
    });

    const validation = new AcmCertificateValidation(this, "validation", {
      certificateArn: certificate.arn,

      // A for_each resource is a map, so the fqdns have to be projected out of
      // its values. There is no typed accessor for this shape — a raw HCL
      // expression is the documented approach.
      validationRecordFqdns: Token.asList(`\${[for record in ${validationRecord.fqn} : record.fqdn]}`),
    });

    this.validatedCertificateArn = validation.certificateArn;
  }
}
