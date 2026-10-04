param(
    [Parameter(Mandatory = $true)][string]$NodePath
)

$ErrorActionPreference = 'Stop'
$node = (Resolve-Path -LiteralPath $NodePath).Path

# The installer runs this once with elevation. Limit inbound access to this bundled runtime,
# its two LAN ports, and the current local subnet. Upgrades update these named rules in place.
foreach ($entry in @(
    @{ Name = 'AgentLink.LAN.TCP.7443'; Label = 'AgentLink LAN service'; Protocol = 'TCP'; Port = '7443' },
    @{ Name = 'AgentLink.LAN.UDP.47823'; Label = 'AgentLink LAN discovery'; Protocol = 'UDP'; Port = '47823' }
)) {
    $rule = Get-NetFirewallRule -Name $entry.Name -ErrorAction SilentlyContinue
    $parameters = @{
        DisplayName = $entry.Label
        Description = 'AgentLink local-network pairing and device discovery'
        Enabled = 'True'
        Profile = 'Any'
        Direction = 'Inbound'
        Action = 'Allow'
        Program = $node
        Protocol = $entry.Protocol
        LocalPort = $entry.Port
        RemoteAddress = 'LocalSubnet'
    }
    if ($rule) {
        [void]$parameters.Remove('DisplayName')
        [void]$parameters.Remove('Description')
        $parameters['Name'] = $entry.Name
        Set-NetFirewallRule @parameters
    } else {
        $parameters['Name'] = $entry.Name
        New-NetFirewallRule @parameters | Out-Null
    }
    if (-not (Get-NetFirewallRule -Name $entry.Name -ErrorAction SilentlyContinue)) {
        throw "Could not configure $($entry.Label)"
    }
}

Write-Output 'AGENTLINK_LAN_FIREWALL_READY'
