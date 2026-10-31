param(
    [Parameter(Mandatory = $true)]
    [string] $LedgerPath
)

$ErrorActionPreference = 'Stop'

try {
    # The register stays in the operator's protected location. Only opaque
    # references leave this process; never print a row or the private path.
    $file = Get-Item -LiteralPath $LedgerPath -Force
    if ($file.PSIsContainer -or $file.Length -lt 1 -or $file.Length -gt 1MB) { throw 'invalid' }
    $expectedColumns = @('request_reference', 'received_at', 'request_expires_at', 'review_decision',
        'reviewed_at', 'attachment_sha256', 'message_locator', 'file_locator',
        'last_successful_reconciliation_at', 'purge_due_at', 'deleted_at')
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    $outstanding = [System.Collections.Generic.List[string]]::new()
    Add-Type -AssemblyName Microsoft.VisualBasic
    $parser = [Microsoft.VisualBasic.FileIO.TextFieldParser]::new($file.FullName, [Text.Encoding]::UTF8, $true)
    try {
        $parser.TextFieldType = [Microsoft.VisualBasic.FileIO.FieldType]::Delimited
        $parser.SetDelimiters(',')
        $parser.HasFieldsEnclosedInQuotes = $true
        $parser.TrimWhiteSpace = $false
        if ($parser.EndOfData) { throw 'invalid' }
        $columns = $parser.ReadFields()
        if (($columns -join ',') -cne ($expectedColumns -join ',')) { throw 'invalid' }
        while (-not $parser.EndOfData) {
            $fields = $parser.ReadFields()
            if ($fields.Count -ne $expectedColumns.Count) { throw 'invalid' }
            $reference = $fields[0]
            if ($reference -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' -or
                -not $seen.Add($reference)) { throw 'invalid' }
            $deleted = $fields[10]
            if ([string]::IsNullOrWhiteSpace($deleted)) {
                $outstanding.Add($reference)
            } else {
                $parsed = [DateTimeOffset]::MinValue
                if ($deleted -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?Z$' -or
                    -not [DateTimeOffset]::TryParse($deleted, [Globalization.CultureInfo]::InvariantCulture,
                        [Globalization.DateTimeStyles]::None, [ref] $parsed) -or $parsed -gt [DateTimeOffset]::UtcNow) { throw 'invalid' }
            }
        }
    } finally {
        $parser.Dispose()
    }
    if ($outstanding.Count -lt 1 -or $outstanding.Count -gt 100) { throw 'invalid' }
    $payload = @{ references = @($outstanding.ToArray()) }
    ConvertTo-Json -InputObject $payload -Compress -Depth 3
} catch {
    [Console]::Error.WriteLine('The private register could not be converted. Check its format and outstanding row count; no complete reference list was produced.')
    exit 1
}
