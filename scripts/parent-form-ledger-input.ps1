[CmdletBinding(DefaultParameterSetName = 'Report')]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'Report')]
    [string] $LedgerPath,
    [Parameter(ParameterSetName = 'Report')]
    [switch] $DeadlineReport,
    [Parameter(Mandatory = $true, ParameterSetName = 'NewUnmatched')]
    [switch] $NewUnmatchedReference
)

$ErrorActionPreference = 'Stop'

if ($NewUnmatchedReference) {
    # A local case ID is visibly different from a server request reference and
    # must never be used as evidence of an actual registration request.
    [Console]::Out.WriteLine(('unmatched:{0}' -f [guid]::NewGuid().ToString()))
    exit 0
}

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
    $deadlines = [System.Collections.Generic.List[object]]::new()
    $outstandingCount = 0
    $now = [DateTimeOffset]::UtcNow
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
            $uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}'
            $unmatched = $reference -cmatch ('^unmatched:' + $uuid + '$')
            if ((-not $unmatched -and $reference -cnotmatch ('^' + $uuid + '$')) -or
                -not $seen.Add($reference)) { throw 'invalid' }
            $unmatchedDue = $null
            if ($unmatched) {
                # Local unmatched messages are incomplete until tied to a real
                # request. Their 14-day clock starts no later than receipt.
                $received = $fields[1]
                $parsedReceived = [DateTimeOffset]::MinValue
                if ([string]::IsNullOrWhiteSpace($fields[6]) -or
                    $received -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?Z$' -or
                    -not [DateTimeOffset]::TryParse($received, [Globalization.CultureInfo]::InvariantCulture,
                        [Globalization.DateTimeStyles]::None, [ref] $parsedReceived) -or $parsedReceived -gt $now) { throw 'invalid' }
                $unmatchedDue = $parsedReceived.AddDays(14)
            }
            $deleted = $fields[10]
            if ([string]::IsNullOrWhiteSpace($deleted)) {
                $outstandingCount++
                if (-not $unmatched) { $outstanding.Add($reference) }
                if ($DeadlineReport) {
                    $due = $fields[9]
                    if ($unmatched -and [string]::IsNullOrWhiteSpace($due)) {
                        $parsedDue = $unmatchedDue
                    } elseif ([string]::IsNullOrWhiteSpace($due)) {
                        $deadlines.Add([pscustomobject]@{ Reference = $reference; Due = $null; Label = 'NO DEADLINE ENTERED - check request status' })
                        continue
                    } else {
                        $parsedDue = [DateTimeOffset]::MinValue
                        if ($due -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?Z$' -or
                            -not [DateTimeOffset]::TryParse($due, [Globalization.CultureInfo]::InvariantCulture,
                                [Globalization.DateTimeStyles]::None, [ref] $parsedDue)) { throw 'invalid' }
                        if ($unmatched -and $parsedDue -gt $unmatchedDue) { throw 'invalid' }
                    }
                    $label = if ($parsedDue -le $now) { 'DUE OR OVERDUE' }
                        elseif ($parsedDue -le $now.AddDays(4)) { 'DUE WITHIN 4 DAYS' }
                        else { 'LATER' }
                    if ($unmatched) { $label = "UNMATCHED MESSAGE - $label" }
                    $deadlines.Add([pscustomobject]@{ Reference = $reference; Due = $parsedDue; Label = $label })
                }
            } else {
                $parsed = [DateTimeOffset]::MinValue
                if ($deleted -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?Z$' -or
                    -not [DateTimeOffset]::TryParse($deleted, [Globalization.CultureInfo]::InvariantCulture,
                        [Globalization.DateTimeStyles]::None, [ref] $parsed) -or $parsed -gt [DateTimeOffset]::UtcNow -or
                    ($unmatched -and $parsed -lt $parsedReceived)) { throw 'invalid' }
            }
        }
    } finally {
        $parser.Dispose()
    }
    if ($outstandingCount -gt 100 -or (-not $DeadlineReport -and $outstanding.Count -lt 1)) { throw 'invalid' }
    if ($DeadlineReport) {
        # Buffer all output until the entire file has been checked. The private
        # register remains authoritative; this only reports entered deadlines.
        $lines = [System.Collections.Generic.List[string]]::new()
        $lines.Add(('PRIVATE FORM DEADLINES - checked {0}' -f $now.ToString('yyyy-MM-ddTHH:mm:ssZ')))
        foreach ($entry in @($deadlines | Sort-Object @{ Expression = { if ($null -eq $_.Due) { [DateTimeOffset]::MaxValue } else { $_.Due } } }, Reference)) {
            $date = if ($null -eq $entry.Due) { 'not entered' } else { $entry.Due.ToString('yyyy-MM-ddTHH:mm:ss.fffffffZ') }
            $lines.Add(('{0} | {1} | {2}' -f $entry.Reference, $date, $entry.Label))
        }
        if ($outstandingCount -eq 0) { $lines.Add('No outstanding rows in this register.') }
        $lines.Add('Verify each deadline against the request and all copies. This report does not prove deletion or send reminders.')
        [Console]::Out.WriteLine(($lines -join [Environment]::NewLine))
        exit 0
    }
    $payload = @{ references = @($outstanding.ToArray()) }
    ConvertTo-Json -InputObject $payload -Compress -Depth 3
} catch {
    [Console]::Error.WriteLine('The private register could not be converted. Check its format and outstanding row count; no complete reference list was produced.')
    exit 1
}
